import { describe, expect, it, vi } from "vitest";
import {
    parseExchangeTime, toRawItem, fetchAnnouncements, makeAnnouncementPoller,
    NseAnnouncementsUnavailable, ANNOUNCEMENTS_ENDPOINT,
} from "../services/news/nseAnnouncements.js";
import { NewsStore } from "../services/news/ingest.js";
import { buildOperatorReport, renderOperatorReport } from "../services/orchestrator/operatorReport.js";

// Row shape taken from the LIVE endpoint audit on 2026-08-30, not invented.
const liveRow = (over = {}) => ({
    symbol: "DYNAMATECH",
    desc: "Copy of Newspaper Publication",
    attchmntText: "Dynamatic Technologies Limited has informed the Exchange about Copy of Newspaper Publication",
    exchdisstime: "28-Aug-2026 23:57:43",
    an_dt: "28-Aug-2026 23:57:42",
    sort_date: "2026-08-28 23:57:42",
    seq_id: "123456",
    sm_name: "Dynamatic Technologies Limited",
    sm_isin: "INE221B01012",
    smIndustry: "Auto Components",
    attchmntFile: "https://nsearchives.nseindia.com/corporate/x.pdf",
    ...over,
});

const jsonResponse = (body, ok = true, status = 200) => ({
    ok, status, json: async () => body,
});

describe("exchange timestamp is IST, not UTC", () => {
    it("converts IST to UTC by subtracting 5:30", () => {
        expect(parseExchangeTime("28-Aug-2026 23:57:43")).toBe("2026-08-28T18:27:43.000Z");
    });

    it("handles a time that crosses back over midnight", () => {
        expect(parseExchangeTime("25-Aug-2026 00:03:21")).toBe("2026-08-24T18:33:21.000Z");
    });

    it("parses every month abbreviation the source uses", () => {
        for (const mon of ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]) {
            expect(parseExchangeTime(`01-${mon}-2026 10:00:00`)).not.toBeNull();
        }
    });

    it("returns null rather than guessing on a malformed time", () => {
        for (const bad of ["garbage", "", null, undefined, "2026-08-28 23:57:43", "28-XXX-2026 10:00:00"]) {
            expect(parseExchangeTime(bad)).toBeNull();
        }
    });
});

describe("row mapping", () => {
    it("maps the audited fields onto the ingestion shape", () => {
        const item = toRawItem(liveRow());
        expect(item.sourceEventId).toBe("123456");
        expect(item.symbol).toBe("DYNAMATECH");
        expect(item.subject).toBe("Copy of Newspaper Publication");
        expect(item.disseminatedAt).toBe("2026-08-28T18:27:43.000Z");
        expect(item.source).toBe("nse_announcements");
    });

    it("drops a row with no usable timestamp instead of admitting it", () => {
        expect(toRawItem(liveRow({ exchdisstime: "" }))).toBeNull();
        expect(toRawItem(liveRow({ exchdisstime: null }))).toBeNull();
    });
});

describe("fetching announcements", () => {
    const window = { from: new Date("2026-08-25T00:00:00Z"), to: new Date("2026-08-28T00:00:00Z") };

    it("calls the audited endpoint with IST-formatted dates", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse([liveRow()]));
        await fetchAnnouncements({ ...window, fetchImpl });
        const url = fetchImpl.mock.calls[0][0];
        expect(url).toContain(ANNOUNCEMENTS_ENDPOINT);
        expect(url).toMatch(/from_date=\d{2}-\d{2}-\d{4}/);
        expect(url).toMatch(/to_date=\d{2}-\d{2}-\d{4}/);
    });

    it("sends the headers NSE gates on", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse([liveRow()]));
        await fetchAnnouncements({ ...window, fetchImpl });
        const headers = fetchImpl.mock.calls[0][1].headers;
        expect(headers["User-Agent"]).toMatch(/Mozilla/);
        expect(headers.Referer).toMatch(/nseindia\.com/);
    });

    it("parses a bare array, the audited shape", async () => {
        const result = await fetchAnnouncements({
            ...window, fetchImpl: async () => jsonResponse([liveRow(), liveRow({ seq_id: "2" })]) });
        expect(result.items).toHaveLength(2);
        expect(result.received).toBe(2);
    });

    it("counts undated rows separately rather than dropping them silently", async () => {
        const result = await fetchAnnouncements({
            ...window, fetchImpl: async () => jsonResponse([liveRow(), liveRow({ exchdisstime: "" })]) });
        expect(result.items).toHaveLength(1);
        expect(result.undated).toBe(1);
    });

    it.each([
        ["an HTTP error", () => jsonResponse(null, false, 503)],
        ["malformed JSON", () => ({ ok: true, status: 200, json: async () => { throw new Error("bad"); } })],
        ["an unexpected shape", () => jsonResponse({ unexpected: true })],
    ])("raises a typed error on %s", async (_label, impl) => {
        await expect(fetchAnnouncements({ ...window, fetchImpl: async () => impl() }))
            .rejects.toThrow(NseAnnouncementsUnavailable);
    });

    it("raises on a network failure or timeout", async () => {
        await expect(fetchAnnouncements({
            ...window, fetchImpl: async () => { throw new Error("ETIMEDOUT"); } }))
            .rejects.toThrow(NseAnnouncementsUnavailable);
    });
});

describe("the poller never kills the loop", () => {
    it("ingests and reports counts", async () => {
        const store = new NewsStore();
        const poll = makeAnnouncementPoller({
            store, fetchImpl: async () => jsonResponse([liveRow(), liveRow({ seq_id: "2" })]) });
        const result = await poll(new Date("2026-08-29T00:00:00Z"));
        expect(result.accepted).toBe(2);
        expect(result.degraded).toBe(false);
    });

    it("deduplicates across overlapping windows", async () => {
        const store = new NewsStore();
        const poll = makeAnnouncementPoller({
            store, fetchImpl: async () => jsonResponse([liveRow()]) });
        await poll(new Date("2026-08-29T00:00:00Z"));
        const second = await poll(new Date("2026-08-29T01:00:00Z"));
        expect(second.accepted).toBe(0);
        expect(store.health().stored).toBe(1);
    });

    it("reports degraded instead of throwing when the source is down", async () => {
        const store = new NewsStore();
        const poll = makeAnnouncementPoller({
            store, fetchImpl: async () => { throw new Error("NSE unreachable"); } });
        const result = await poll(new Date());
        expect(result.degraded).toBe(true);
        expect(result.error).toMatch(/unreachable/);
        expect(result.accepted).toBe(0);
    });

    it("an outage leaves previously stored news intact", async () => {
        const store = new NewsStore();
        let fail = false;
        const poll = makeAnnouncementPoller({
            store, fetchImpl: async () => {
                if (fail) throw new Error("down");
                return jsonResponse([liveRow()]);
            } });
        await poll(new Date());
        fail = true;
        await poll(new Date());
        expect(store.health().stored).toBe(1);
    });
});

describe("operator report", () => {
    const runtime = {
        health: () => ({
            mode: "PAPER", liveExecutionEnabled: false,
            orchestrator: {
                phase: "RUNNING", session: "OPEN", halted: false, contexts: 12,
                queue: { depth: 2, capacity: 200 },
                scheduler: { running: true, jobs: [
                    { name: "position-monitor", runs: 10, failures: 0, skipped: 0, lastError: null },
                    { name: "news-ingest", runs: 3, failures: 1, skipped: 0, lastError: "down" },
                ] },
                metrics: {
                    reasoningInvocations: 4, reasoningAvoided: 96, riskRejections: 1,
                    executions: 2, anomaliesDetected: 7, marketWideAnomalies: 1,
                    newsEventsReceived: 5, lastDecisionAt: "2026-08-30T06:00:00Z",
                },
            },
            venue: { resting: 1 }, runtime: { candidatesScanned: 40 },
        }),
        sourcePorts: {
            loadPositions: async () => [{
                symbol: "RELIANCE", quantity: 10, entryPricePaise: 100000,
                currentPricePaise: 101000, unrealisedPnlPaise: 10000,
                stale: false, hasThesis: true, thesisId: "t-1", holdingSeconds: 600,
            }],
        },
    };
    const engine = { openOrders: async () => [
        { id: 1, state: "WORKING" }, { id: 2, state: "AMBIGUOUS" }] };
    const connection = { health: () => ({
        state: "CONNECTED", trusted: true, dataAgeMs: 1200,
        lastTickAt: 1, reconnectAttempts: 0 }) };

    it("answers every operator question", async () => {
        const report = await buildOperatorReport({
            runtime, engine, connection, newsStore: new NewsStore(), userId: 1 });

        expect(report.alive).toBe(true);
        expect(report.mode).toBe("PAPER");
        expect(report.liveExecutionEnabled).toBe(false);
        expect(report.marketData.state).toBe("CONNECTED");
        expect(report.watching.positions).toBe(1);
        expect(report.positions[0].thesisId).toBe("t-1");
        expect(report.orders.ambiguous).toBe(1);
        expect(report.orders.blockingNewExposure).toBe(true);
        expect(report.reasoning.invocations).toBe(4);
        expect(report.reasoning.avoided).toBe(96);
        expect(report.intelligence.marketWideAnomalies).toBe(1);
        expect(report.scheduler.failingJobs).toEqual(["news-ingest"]);
        expect(report.newsSource).toHaveProperty("stored");
    });

    it("renders a compact human-readable form", async () => {
        const report = await buildOperatorReport({
            runtime, engine, connection, newsStore: new NewsStore(), userId: 1 });
        const text = renderOperatorReport(report);
        expect(text).toMatch(/brain\s+ALIVE/);
        expect(text).toMatch(/BLOCKING NEW EXPOSURE/);
        expect(text).toMatch(/live money\s+DISABLED/);
    });

    it("reports NOT RUNNING when the runtime is absent", async () => {
        const report = await buildOperatorReport({ runtime: null, engine, userId: 1 });
        expect(report.alive).toBe(false);
        expect(renderOperatorReport(report)).toMatch(/NOT RUNNING/);
    });
});
