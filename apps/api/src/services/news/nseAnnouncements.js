import { SOURCE } from "./ingest.js";

// NSE corporate-announcements adapter.
//
// Endpoint shape AUDITED against the live API on 2026-08-30, not assumed:
//   GET https://www.nseindia.com/api/corporate-announcements
//       ?index=equities&from_date=DD-MM-YYYY&to_date=DD-MM-YYYY
//   200, JSON array, 2,495 rows for a 3-day window, 20 fields per row.
//
// Measured on that sample:
//   seq_id        unique 2495/2495, never blank -> stable source identity
//   symbol        never blank
//   desc          never blank -> the subject used for classification
//   exchdisstime  populated 2495/2495, format "28-Aug-2026 23:57:43"
//
// TIMEZONE: exchdisstime is exchange-local IST, not UTC. The measured
// distribution peaks at 15:00-19:00, the post-market filing rush, which only
// makes sense in IST. Treating it as UTC would shift every news PIT boundary
// by 5.5 hours and let the brain "see" announcements before they existed.
//
// No credentials are required; NSE gates on User-Agent and Referer.

export const ANNOUNCEMENTS_ENDPOINT =
    "https://www.nseindia.com/api/corporate-announcements?index=equities";
export const ANNOUNCEMENTS_REFERER =
    "https://www.nseindia.com/companies-listing/corporate-filings-announcements";
const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/121.0 Safari/537.36";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
                 Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// "28-Aug-2026 23:57:43" (IST) -> ISO UTC. Returns null rather than guessing,
// because an announcement with no reliable time has no PIT guarantee.
export const parseExchangeTime = (text) => {
    if (typeof text !== "string") return null;
    const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/.exec(text.trim());
    if (!m) return null;
    const [, dd, mon, yyyy, hh, mi, ss] = m;
    const month = MONTHS[mon];
    if (month === undefined) return null;
    const istEpoch = Date.UTC(Number(yyyy), month, Number(dd), Number(hh), Number(mi), Number(ss));
    return new Date(istEpoch - IST_OFFSET_MS).toISOString();
};

const formatDate = (date) => {
    const ist = new Date(date.getTime() + IST_OFFSET_MS);
    const dd = String(ist.getUTCDate()).padStart(2, "0");
    const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
    return `${dd}-${mm}-${ist.getUTCFullYear()}`;
};

export class NseAnnouncementsUnavailable extends Error {}

// Maps one raw row onto the shape NewsStore.normalize expects. Rows without a
// usable timestamp are dropped here rather than admitted with a guess.
export const toRawItem = (row) => {
    const disseminatedAt = parseExchangeTime(row.exchdisstime);
    if (!disseminatedAt) return null;
    return {
        source: SOURCE.NSE_ANNOUNCEMENTS,
        sourceEventId: row.seq_id ? String(row.seq_id) : null,
        symbol: row.symbol ?? null,
        subject: row.desc ?? null,
        headline: row.attchmntText ?? null,
        disseminatedAt,
        url: row.attchmntFile ?? null,
    };
};

export const fetchAnnouncements = async ({
    from, to, fetchImpl = fetch, timeoutMs = 30_000,
} = {}) => {
    const url = `${ANNOUNCEMENTS_ENDPOINT}&from_date=${formatDate(from)}&to_date=${formatDate(to)}`;

    let response;
    try {
        response = await fetchImpl(url, {
            headers: { "User-Agent": USER_AGENT, Referer: ANNOUNCEMENTS_REFERER,
                       Accept: "application/json" },
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (err) {
        throw new NseAnnouncementsUnavailable(`request failed: ${err.message}`);
    }

    if (!response.ok) {
        throw new NseAnnouncementsUnavailable(`HTTP ${response.status}`);
    }

    let payload;
    try {
        payload = await response.json();
    } catch (err) {
        throw new NseAnnouncementsUnavailable(`malformed JSON: ${err.message}`);
    }

    // The audited response is a bare array; the defensive branches cover the
    // shapes NSE uses on sibling endpoints without pretending to have seen them.
    const rows = Array.isArray(payload)
        ? payload
        : (payload?.rows ?? payload?.data ?? null);
    if (!Array.isArray(rows)) {
        throw new NseAnnouncementsUnavailable("unexpected response shape");
    }

    const items = [];
    let undated = 0;
    for (const row of rows) {
        const item = toRawItem(row);
        if (item) items.push(item); else undated += 1;
    }
    return { items, undated, received: rows.length };
};

// Scheduler job body. Overlapping windows are expected and harmless: NewsStore
// deduplicates on seq_id, so re-fetching the same day costs nothing.
export const makeAnnouncementPoller = ({ store, lookbackMs = 6 * 60 * 60 * 1000,
                                         fetchImpl = fetch, logger = null }) =>
    async (now = new Date()) => {
        try {
            const { items, undated, received } = await fetchAnnouncements({
                from: new Date(now.getTime() - lookbackMs), to: now, fetchImpl });
            const accepted = store.ingest(items, now);
            return { received, accepted: accepted.length, undated,
                     deduplicated: store.health().deduplicated, degraded: false };
        } catch (err) {
            // A source outage must never kill the loop, and absence of news is
            // never evidence that nothing happened.
            logger?.error?.("NseAnnouncements", "poll failed", { error: err.message });
            return { received: 0, accepted: 0, undated: 0, degraded: true, error: err.message };
        }
    };
