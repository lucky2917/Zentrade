import { createHash } from "node:crypto";
import { classify, warrantsReasoning, MATERIALITY } from "./materiality.js";
import { isVisibleAt, ingestionLagMs } from "./pit.js";
import { makeEvent, EVENT_TYPES, SEVERITY } from "../autonomous/events.js";

// News and corporate-announcement ingestion.
//
//   INGEST -> NORMALIZE -> DEDUPLICATE -> CLASSIFY -> SCORE -> MAP -> EMIT
//
// It emits events. It cannot trade, and nothing here calls execution.
//
// Source note: NSE corporate-announcements carries `exchdisstime`, measured
// populated to the second on 2,594 of 2,594 sampled rows. That is the event's
// real time and is used in preference to any publication date. The
// corporate-ACTIONS feed equivalent field was empty on all 3,152 sampled rows,
// which is why announcements are the better source here.

export const SOURCE = { NSE_ANNOUNCEMENTS: "nse_announcements", FINNHUB: "finnhub" };

export const NEWS_SCHEMA_VERSION = "news_v1";

// Materiality maps to event severity. LOW is recorded but never wakes the LLM.
const SEVERITY_BY_MATERIALITY = {
    [MATERIALITY.CRITICAL]: SEVERITY.CRITICAL,
    [MATERIALITY.HIGH]: SEVERITY.WARNING,
    [MATERIALITY.MEDIUM]: SEVERITY.INFO,
    [MATERIALITY.LOW]: SEVERITY.INFO,
};

export const stripSymbol = (raw) =>
    String(raw ?? "").trim().toUpperCase().replace(/^NSE:/, "").replace(/-EQ$/, "");

// Stable identity. Prefer the source own id; fall back to a fingerprint over
// the fields that make an announcement what it is. Time is included so a
// genuinely repeated subject on a later date is a new event, not a duplicate.
export const identityOf = (raw) => {
    if (raw.sourceEventId) return `${raw.source}:${raw.sourceEventId}`;
    const parts = [raw.source, stripSymbol(raw.symbol), raw.subject ?? "", raw.disseminatedAt ?? ""];
    const fingerprint = createHash("sha256").update(parts.join(" ")).digest("hex").slice(0, 32);
    return `${raw.source}:fp:${fingerprint}`;
};

export const normalize = (raw, receivedAt = new Date()) => {
    const disseminated = raw.disseminatedAt ?? raw.exchdisstime ?? null;
    if (!disseminated) return null;   // no event time means no PIT guarantee
    const when = new Date(disseminated);
    if (Number.isNaN(when.getTime())) return null;

    const classification = classify(raw);

    return {
        id: identityOf(raw),
        schemaVersion: NEWS_SCHEMA_VERSION,
        source: raw.source,
        sourceEventId: raw.sourceEventId ?? null,
        symbol: stripSymbol(raw.symbol),
        marketWide: !raw.symbol,
        subject: raw.subject ?? null,
        category: classification.category,
        materiality: classification.materiality,
        classificationRationale: classification.rationale,
        matchedRule: classification.matchedRule,
        disseminatedAt: when.toISOString(),
        receivedAt: (receivedAt instanceof Date ? receivedAt : new Date(receivedAt)).toISOString(),
        raw: { subject: raw.subject ?? null, url: raw.url ?? null },
    };
};

// In-process store. Postgres-backed persistence is deliberately not added
// until measurement shows the in-process path is insufficient; the existing
// event tables already carry anything that reaches reasoning.
export class NewsStore {
    constructor() {
        this.byId = new Map();
        this.stats = { received: 0, normalized: 0, deduplicated: 0, malformed: 0 };
    }

    // Repeated polling must produce ONE canonical event, not repeated triggers.
    ingest(rawItems, receivedAt = new Date()) {
        const accepted = [];
        for (const raw of rawItems) {
            this.stats.received += 1;
            const event = normalize(raw, receivedAt);
            if (!event) { this.stats.malformed += 1; continue; }
            if (this.byId.has(event.id)) { this.stats.deduplicated += 1; continue; }
            this.byId.set(event.id, event);
            this.stats.normalized += 1;
            accepted.push(event);
        }
        // Deterministic ordering by event time, then id: two runs over the
        // same input produce the same sequence regardless of arrival order.
        accepted.sort((a, b) =>
            a.disseminatedAt.localeCompare(b.disseminatedAt) || a.id.localeCompare(b.id));
        return accepted;
    }

    // PIT gate: only what the exchange had disseminated by as_of.
    visibleAt(asOf) {
        return [...this.byId.values()]
            .filter((e) => isVisibleAt(e, asOf))
            .sort((a, b) =>
                a.disseminatedAt.localeCompare(b.disseminatedAt) || a.id.localeCompare(b.id));
    }

    health() {
        return { ...this.stats, stored: this.byId.size };
    }
}

// Turns a normalized news item into a queue event. Only material items become
// events that can wake reasoning; the rest are recorded and stay quiet.
export const toEvent = (item, { thesisId = null, correlationId = null } = {}) => makeEvent({
    type: EVENT_TYPES.NEWS_EVENT,
    symbol: item.marketWide ? "MARKET" : item.symbol,
    severity: SEVERITY_BY_MATERIALITY[item.materiality] ?? SEVERITY.INFO,
    thesisId,
    correlationId: correlationId ?? `news-${item.id}`,
    source: item.source,
    observed: {
        newsId: item.id, category: item.category, materiality: item.materiality,
        subject: item.subject, disseminatedAt: item.disseminatedAt,
        receivedAt: item.receivedAt, lagMs: ingestionLagMs(item),
        rationale: item.classificationRationale, schemaVersion: item.schemaVersion,
    },
    reason: `${item.category} (${item.materiality}): ${item.subject ?? "no subject"}`.slice(0, 300),
    observedAt: item.disseminatedAt,
    // One event per news item: repeated polling coalesces onto the same key.
    bucket: item.id,
});

// Events for reasoning at a given as_of. Held positions are attached so a news
// event about something we own routes to position reassessment.
export const eventsForReasoning = (store, asOf, { thesisBySymbol = new Map() } = {}) =>
    store.visibleAt(asOf)
        .filter((item) => warrantsReasoning(item.materiality))
        .map((item) => toEvent(item, { thesisId: thesisBySymbol.get(item.symbol) ?? null }));
