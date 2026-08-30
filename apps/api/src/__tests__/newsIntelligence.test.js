import { describe, expect, it, vi } from "vitest";
import { observeSymbol, observeUniverse, buildObservation } from "../services/intelligence/observe.js";
import { Orchestrator } from "../services/orchestrator/orchestrator.js";
import { classify, MATERIALITY, EVENT_CATEGORY, warrantsReasoning } from "../services/news/materiality.js";
import { isVisibleAt, assertNotFuture, FutureEventRejected, ingestionLagMs } from "../services/news/pit.js";
import { NewsStore, normalize, identityOf, toEvent, eventsForReasoning, SOURCE } from "../services/news/ingest.js";
import { SEVERITY, EVENT_TYPES } from "../services/autonomous/events.js";

const istAt = (h, m, day = 1) => new Date(Date.UTC(2026, 8, day, 0, h * 60 + m - 330));
const bar = (ts, close, volume = 1000) => ({ ts, close, high: close + 1, low: close - 1, volume });
const calm = (n = 40, base = 100) =>
    Array.from({ length: n }, (_, i) => bar(istAt(10, 0).toISOString(), base + (i % 2 ? -0.05 : 0.05), 1000));

// ---- PART A: live intelligence wiring --------------------------------------

describe("observation assembles deterministic context", () => {
    const asOf = istAt(11, 0);

    it("carries session phase, VWAP and MTF into one context", () => {
        const ctx = buildObservation({
            symbol: "X", bars1m: calm(10), bars5m: calm(10), bars15m: calm(10),
            price: 100, asOf,
        });
        expect(ctx.sessionPhase).toBe("MID_SESSION");   // 11:00 IST is past the early boundary
        expect(ctx.vwapAvailable).toBe(true);
        expect(ctx.mtf).toHaveProperty("aligned");
        expect(ctx.asOf).toBe(asOf.toISOString());
    });

    it("keeps observation time separate from calculation time", () => {
        const ctx = buildObservation({ symbol: "X", bars1m: calm(5), price: 100, asOf });
        expect(ctx.asOf).toBe(asOf.toISOString());
        expect(ctx.calculatedAt).not.toBe(ctx.asOf);
    });

    it("reports how much history it actually had", () => {
        const ctx = buildObservation({ symbol: "X", bars1m: calm(3), bars5m: [], bars15m: [], asOf });
        expect(ctx.barsSeen).toEqual({ m1: 3, m5: 0, m15: 0 });
        expect(ctx.mtf.complete).toBe(false);
    });

    it("emits no event on a quiet symbol", () => {
        const { events } = observeSymbol({ symbol: "X", bars1m: calm(41), price: 100, asOf });
        expect(events).toEqual([]);
    });

    it("emits an anomaly event on a shock", () => {
        const bars = [...calm(40), bar(istAt(11, 0).toISOString(), 140, 30000)];
        const { events } = observeSymbol({ symbol: "X", bars1m: bars, price: 140, asOf });
        expect(events.length).toBeGreaterThan(0);
        expect(events.every((e) => e.observed.detector)).toBe(true);
    });
});

describe("universe observation separates symbol from market-wide", () => {
    const asOf = istAt(11, 0);

    it("does not raise a market event for one moving symbol", () => {
        const observations = Array.from({ length: 20 }, (_, i) => ({
            symbol: `S${i}`,
            bars1m: i === 0 ? [...calm(40), bar("t", 140, 30000)] : calm(41),
        }));
        const result = observeUniverse({ observations, asOf });
        expect(result.marketWide).toBe(false);
        expect(result.events.some((e) => e.symbol === "S0")).toBe(true);
    });

    it("raises one market event when the universe moves together", () => {
        const observations = Array.from({ length: 20 }, (_, i) => ({
            symbol: `S${i}`, bars1m: [...calm(40, 100), bar("t", 97, 1000)],
        }));
        const result = observeUniverse({ observations, asOf });
        expect(result.marketWide).toBe(true);
        expect(result.events.filter((e) => e.symbol === "MARKET")).toHaveLength(1);
    });

    it("is deterministic over identical input", () => {
        const build = () => JSON.stringify(observeUniverse({
            observations: [{ symbol: "A", bars1m: [...calm(40), bar("t", 140, 30000)] }],
            asOf, calculatedAt: asOf }));
        const first = build();
        for (let i = 0; i < 20; i += 1) expect(build()).toBe(first);
    });
});

describe("orchestrator consumes intelligence and news", () => {
    const asOf = istAt(12, 0);
    const position = (over = {}) => ({
        symbol: "RELIANCE", userId: 1, side: "BUY", quantity: 10,
        entryPricePaise: 100000, currentPricePaise: 100000, exposurePaise: 1000000,
        stale: false, dataAgeMs: 1000, sessionPhase: "MID_SESSION",
        thesisId: "t-1", correlationId: "c-1", holdingSeconds: 3600,
        stopPaise: 95000, targetPaise: 110000,
        stopDistance: 1, targetDistance: 1, pnlPercent: 0,
        unrealisedPnlPaise: 0, hasThesis: true, ...over,
    });

    const build = (over = {}) => {
        const ports = {
            loadPositions: async () => [position()],
            loadPortfolio: async () => ({ userId: 1, grossExposurePaise: 1000000, unrealisedPnlPaise: 0 }),
            positionFor: async () => position({ stopDistance: -0.2 }),
            loadThesis: async () => ({ id: "t-1", side: "BUY", entry_price_paise: 100000 }),
            recordEvent: vi.fn(async (e) => ({ id: `ev-${e.key}` })),
            reassess: vi.fn(async () => ({ action: "HOLD", confidence: "LOW" })),
            intentFrom: () => null,
            evaluateRisk: vi.fn(async () => ({ decision: "ALLOW" })),
            execute: vi.fn(async () => ({})),
            journal: vi.fn(async () => ({})),
            openOrders: async () => [],
            reconcileAll: async () => [],
            expireStaleOrders: async () => [],
            ...over,
        };
        return { ports, orch: new Orchestrator({ ports, clock: () => asOf }) };
    };

    it("routes an anomaly from observation into the queue", async () => {
        const { orch } = build({
            loadObservations: async () => [{
                symbol: "RELIANCE", bars1m: [...calm(40), bar("t", 140, 30000)], price: 140,
            }],
        });
        await orch.monitorCycle();
        expect(orch.health().metrics.anomaliesDetected).toBeGreaterThan(0);
        // RELIANCE is held, so the orchestrator attaches its thesis and the
        // anomaly routes to position reassessment rather than candidate work.
        expect(orch.queue.size).toBeGreaterThan(0);
    });

    it("counts a market-wide anomaly separately", async () => {
        const { orch } = build({
            loadObservations: async () => Array.from({ length: 20 }, (_, i) => ({
                symbol: `S${i}`, bars1m: [...calm(40), bar("t", 97, 1000)],
            })),
        });
        await orch.monitorCycle();
        expect(orch.health().metrics.marketWideAnomalies).toBe(1);
    });

    it("a quiet universe produces no anomaly and no reasoning", async () => {
        const { orch, ports } = build({
            loadObservations: async () => [{ symbol: "RELIANCE", bars1m: calm(41), price: 100 }],
        });
        await orch.monitorCycle();
        await orch.reasoningCycle();
        expect(orch.health().metrics.anomaliesDetected).toBe(0);
        expect(ports.reassess).not.toHaveBeenCalled();
    });

    it("passes market context into reasoning", async () => {
        const { orch, ports } = build({
            loadObservations: async () => [{
                symbol: "RELIANCE", bars1m: [...calm(40), bar("t", 140, 30000)], price: 140,
            }],
            positionFor: async () => position({ stopDistance: -0.2 }),
        });
        await orch.monitorCycle();
        await orch.reasoningCycle();
        expect(ports.reassess).toHaveBeenCalled();
        const call = ports.reassess.mock.calls[0][0];
        expect(call).toHaveProperty("marketState");
        expect(call.marketState.sessionPhase).toBeDefined();
    });

    it("accepts news events into the same queue", async () => {
        const store = new NewsStore();
        store.ingest([{
            source: SOURCE.NSE_ANNOUNCEMENTS, sourceEventId: "n1", symbol: "RELIANCE",
            subject: "Financial Results for the quarter", disseminatedAt: istAt(11, 0).toISOString(),
        }]);
        const { orch } = build({
            pendingNewsEvents: async (now) => eventsForReasoning(store, now,
                { thesisBySymbol: new Map([["RELIANCE", "t-1"]]) }),
        });
        await orch.monitorCycle();
        expect(orch.health().metrics.newsEventsReceived).toBe(1);
        expect(orch.queue.size).toBe(1);
    });

    it("news never reaches execution directly", async () => {
        const store = new NewsStore();
        store.ingest([{
            source: SOURCE.NSE_ANNOUNCEMENTS, sourceEventId: "n2", symbol: "RELIANCE",
            subject: "Merger with subsidiary", disseminatedAt: istAt(11, 0).toISOString(),
        }]);
        const { orch, ports } = build({
            pendingNewsEvents: async (now) => eventsForReasoning(store, now,
                { thesisBySymbol: new Map([["RELIANCE", "t-1"]]) }),
        });
        await orch.monitorCycle();
        await orch.reasoningCycle();
        expect(ports.execute).not.toHaveBeenCalled();
        expect(ports.evaluateRisk).not.toHaveBeenCalled();   // HOLD produced no intent
    });

    it("survives a news source outage without dying", async () => {
        const { orch } = build({
            pendingNewsEvents: async () => { throw new Error("news source down"); },
        });
        await expect(orch.monitorCycle()).rejects.toThrow();
        // The scheduler isolates it: the job records a failure, the loop lives.
        await orch.start();
        const result = await orch.scheduler.runJobOnce("position-monitor");
        expect(result.ok).toBe(false);
        expect(orch.scheduler.health().running).toBe(true);
        await orch.stop();
    });
});

// ---- PART B: news intelligence ---------------------------------------------

describe("materiality classification is deterministic", () => {
    it.each([
        ["Financial Results for Q2", EVENT_CATEGORY.EARNINGS, MATERIALITY.HIGH],
        ["Bonus issue of equity shares", EVENT_CATEGORY.CORPORATE_ACTION, MATERIALITY.HIGH],
        ["Scheme of Merger with subsidiary", EVENT_CATEGORY.MATERIAL_COMPANY_EVENT, MATERIALITY.CRITICAL],
        ["SEBI penalty order", EVENT_CATEGORY.REGULATORY, MATERIALITY.HIGH],
        ["Newspaper Publication of results", EVENT_CATEGORY.ROUTINE_DISCLOSURE, MATERIALITY.LOW],
        ["Trading Window closure", EVENT_CATEGORY.ROUTINE_DISCLOSURE, MATERIALITY.LOW],
    ])("classifies %s", (subject, category, materiality) => {
        const r = classify({ subject });
        expect(r.category).toBe(category);
        expect(r.materiality).toBe(materiality);
        expect(r.rationale.length).toBeGreaterThan(5);
    });

    it("treats an unmatched subject as UNKNOWN, not routine", () => {
        const r = classify({ subject: "Some entirely novel corporate development" });
        expect(r.category).toBe(EVENT_CATEGORY.UNKNOWN);
        expect(r.materiality).toBe(MATERIALITY.MEDIUM);
    });

    it("treats a missing subject as unclassifiable rather than guessing", () => {
        const r = classify({});
        expect(r.category).toBe(EVENT_CATEGORY.UNKNOWN);
        expect(r.materiality).toBe(MATERIALITY.LOW);
        expect(r.rationale).toMatch(/not classifiable/);
    });

    it("is stable across repeated calls", () => {
        const first = JSON.stringify(classify({ subject: "Financial Results" }));
        for (let i = 0; i < 20; i += 1) {
            expect(JSON.stringify(classify({ subject: "Financial Results" }))).toBe(first);
        }
    });

    it("only HIGH and CRITICAL warrant reasoning", () => {
        expect(warrantsReasoning(MATERIALITY.CRITICAL)).toBe(true);
        expect(warrantsReasoning(MATERIALITY.HIGH)).toBe(true);
        expect(warrantsReasoning(MATERIALITY.MEDIUM)).toBe(false);
        expect(warrantsReasoning(MATERIALITY.LOW)).toBe(false);
    });
});

describe("news point-in-time boundary", () => {
    const decision = istAt(12, 0).toISOString();
    const ev = (at) => ({ disseminatedAt: at, receivedAt: at });

    it("hides an announcement disseminated after the decision", () => {
        expect(isVisibleAt(ev(istAt(12, 1).toISOString()), decision)).toBe(false);
    });

    it("shows one disseminated before the decision", () => {
        expect(isVisibleAt(ev(istAt(11, 59).toISOString()), decision)).toBe(true);
    });

    it("is INCLUSIVE exactly at the boundary: a disseminated announcement was available", () => {
        expect(isVisibleAt(ev(decision), decision)).toBe(true);
    });

    it("throws when a future event is forced through the guard", () => {
        expect(() => assertNotFuture(ev(istAt(13, 0).toISOString()), decision))
            .toThrow(FutureEventRejected);
    });

    it("rejects unparseable timestamps rather than admitting them", () => {
        expect(isVisibleAt(ev("not a date"), decision)).toBe(false);
    });

    it("reports ingestion lag without altering event time", () => {
        const item = { disseminatedAt: istAt(12, 0).toISOString(), receivedAt: istAt(12, 5).toISOString() };
        expect(ingestionLagMs(item)).toBe(5 * 60 * 1000);
    });
});

describe("news ingestion, dedup and ordering", () => {
    const at = istAt(11, 0).toISOString();
    const raw = (over = {}) => ({
        source: SOURCE.NSE_ANNOUNCEMENTS, sourceEventId: "n1", symbol: "NSE:RELIANCE-EQ",
        subject: "Financial Results", disseminatedAt: at, ...over,
    });

    it("normalizes symbol and prefers exchange dissemination time", () => {
        const item = normalize(raw());
        expect(item.symbol).toBe("RELIANCE");
        expect(item.disseminatedAt).toBe(new Date(at).toISOString());
        expect(item.schemaVersion).toBe("news_v1");
    });

    it("accepts exchdisstime as the event time", () => {
        const item = normalize({ source: "x", symbol: "A", subject: "s", exchdisstime: at });
        expect(item.disseminatedAt).toBe(new Date(at).toISOString());
    });

    it("rejects an item with no event time: no PIT guarantee is possible", () => {
        expect(normalize({ source: "x", symbol: "A", subject: "s" })).toBeNull();
    });

    it("rejects an unparseable event time", () => {
        expect(normalize(raw({ disseminatedAt: "garbage" }))).toBeNull();
    });

    it("uses source identity when available", () => {
        expect(identityOf(raw())).toBe("nse_announcements:n1");
    });

    it("fingerprints deterministically when no source id exists", () => {
        const a = identityOf(raw({ sourceEventId: null }));
        const b = identityOf(raw({ sourceEventId: null }));
        expect(a).toBe(b);
        expect(a).toMatch(/:fp:/);
    });

    it("does not merge unrelated announcements", () => {
        const a = identityOf(raw({ sourceEventId: null, subject: "Financial Results" }));
        const b = identityOf(raw({ sourceEventId: null, subject: "Bonus Issue" }));
        expect(a).not.toBe(b);
    });

    it("repeated polling yields one canonical event", () => {
        const store = new NewsStore();
        expect(store.ingest([raw()])).toHaveLength(1);
        expect(store.ingest([raw()])).toHaveLength(0);
        expect(store.ingest([raw()])).toHaveLength(0);
        expect(store.health().stored).toBe(1);
        expect(store.health().deduplicated).toBe(2);
    });

    it("counts malformed items without dying", () => {
        const store = new NewsStore();
        store.ingest([raw(), { source: "x" }, { source: "y", disseminatedAt: "bad" }]);
        expect(store.health().malformed).toBe(2);
        expect(store.health().stored).toBe(1);
    });

    it("orders out-of-order arrivals deterministically by event time", () => {
        const store = new NewsStore();
        const accepted = store.ingest([
            raw({ sourceEventId: "b", disseminatedAt: istAt(12, 0).toISOString() }),
            raw({ sourceEventId: "a", disseminatedAt: istAt(10, 0).toISOString() }),
        ]);
        expect(accepted.map((e) => e.sourceEventId)).toEqual(["a", "b"]);
    });

    it("visibleAt applies the PIT gate", () => {
        const store = new NewsStore();
        store.ingest([
            raw({ sourceEventId: "past", disseminatedAt: istAt(10, 0).toISOString() }),
            raw({ sourceEventId: "future", disseminatedAt: istAt(14, 0).toISOString() }),
        ]);
        const visible = store.visibleAt(istAt(12, 0).toISOString());
        expect(visible.map((e) => e.sourceEventId)).toEqual(["past"]);
    });
});

describe("news events reaching the queue", () => {
    const at = istAt(11, 0).toISOString();

    it("only material items become reasoning events", () => {
        const store = new NewsStore();
        store.ingest([
            { source: "s", sourceEventId: "1", symbol: "A", subject: "Financial Results", disseminatedAt: at },
            { source: "s", sourceEventId: "2", symbol: "B", subject: "Trading Window closure", disseminatedAt: at },
        ]);
        const events = eventsForReasoning(store, istAt(12, 0).toISOString());
        expect(events).toHaveLength(1);
        expect(events[0].symbol).toBe("A");
    });

    it("attaches a thesis so a held symbol routes to position reassessment", () => {
        const store = new NewsStore();
        store.ingest([{ source: "s", sourceEventId: "1", symbol: "A", subject: "Merger", disseminatedAt: at }]);
        const [event] = eventsForReasoning(store, istAt(12, 0).toISOString(),
            { thesisBySymbol: new Map([["A", "thesis-1"]]) });
        expect(event.thesisId).toBe("thesis-1");
        expect(event.severity).toBe(SEVERITY.CRITICAL);
    });

    it("a candidate without a position carries no thesis", () => {
        const store = new NewsStore();
        store.ingest([{ source: "s", sourceEventId: "1", symbol: "Z", subject: "Merger", disseminatedAt: at }]);
        const [event] = eventsForReasoning(store, istAt(12, 0).toISOString());
        expect(event.thesisId).toBeNull();
    });

    it("repeated events for one item share a key, so they coalesce", () => {
        const store = new NewsStore();
        store.ingest([{ source: "s", sourceEventId: "1", symbol: "A", subject: "Merger", disseminatedAt: at }]);
        const a = eventsForReasoning(store, istAt(12, 0).toISOString());
        const b = eventsForReasoning(store, istAt(13, 0).toISOString());
        expect(a[0].key).toBe(b[0].key);
    });

    it("preserves full evidence and provenance", () => {
        const store = new NewsStore();
        store.ingest([{ source: SOURCE.NSE_ANNOUNCEMENTS, sourceEventId: "1", symbol: "A",
                        subject: "Financial Results", disseminatedAt: at }]);
        const [event] = eventsForReasoning(store, istAt(12, 0).toISOString());
        expect(event.observed).toMatchObject({
            category: EVENT_CATEGORY.EARNINGS, materiality: MATERIALITY.HIGH,
            schemaVersion: "news_v1",
        });
        expect(event.observed.disseminatedAt).toBeDefined();
        expect(event.observed.receivedAt).toBeDefined();
        expect(event.observed.rationale).toBeTruthy();
        expect(event.type).toBe(EVENT_TYPES.NEWS_EVENT);
    });

    it("multiple distinct news events for one symbol remain distinct", () => {
        const store = new NewsStore();
        store.ingest([
            { source: "s", sourceEventId: "1", symbol: "A", subject: "Financial Results", disseminatedAt: at },
            { source: "s", sourceEventId: "2", symbol: "A", subject: "Merger", disseminatedAt: at },
        ]);
        const events = eventsForReasoning(store, istAt(12, 0).toISOString());
        expect(new Set(events.map((e) => e.key)).size).toBe(2);
    });

    it("is deterministic end to end", () => {
        const build = () => {
            const store = new NewsStore();
            store.ingest([
                { source: "s", sourceEventId: "2", symbol: "B", subject: "Merger", disseminatedAt: istAt(11, 30).toISOString() },
                { source: "s", sourceEventId: "1", symbol: "A", subject: "Financial Results", disseminatedAt: at },
            ], new Date("2026-09-01T06:00:00Z"));
            return JSON.stringify(eventsForReasoning(store, istAt(12, 0).toISOString()));
        };
        const first = build();
        for (let i = 0; i < 20; i += 1) expect(build()).toBe(first);
    });
});

describe("candidate path is separate from position path", () => {
    const asOf = istAt(12, 0);
    const held = {
        symbol: "RELIANCE", userId: 1, side: "BUY", quantity: 10,
        entryPricePaise: 100000, currentPricePaise: 100000, exposurePaise: 1000000,
        stale: false, dataAgeMs: 1000, sessionPhase: "MID_SESSION",
        thesisId: "t-1", correlationId: "c-1", holdingSeconds: 3600,
        stopPaise: 95000, targetPaise: 110000, stopDistance: 1, targetDistance: 1,
        pnlPercent: 0, unrealisedPnlPaise: 0, hasThesis: true,
    };

    const build = (over = {}) => {
        const ports = {
            loadPositions: async () => [held],
            loadPortfolio: async () => ({ userId: 1, grossExposurePaise: 1000000, unrealisedPnlPaise: 0 }),
            positionFor: async () => held,
            loadThesis: async () => ({ id: "t-1", side: "BUY", entry_price_paise: 100000 }),
            recordEvent: vi.fn(async (e) => ({ id: `ev-${e.key}` })),
            reassess: vi.fn(async () => ({ action: "HOLD", confidence: "LOW" })),
            analyseCandidate: vi.fn(async () => ({ action: "WATCH", confidence: "LOW" })),
            intentFrom: () => null,
            evaluateRisk: vi.fn(async () => ({ decision: "ALLOW" })),
            execute: vi.fn(async () => ({})),
            journal: vi.fn(async () => ({})),
            openOrders: async () => [], reconcileAll: async () => [], expireStaleOrders: async () => [],
            ...over,
        };
        return { ports, orch: new Orchestrator({ ports, clock: () => asOf }) };
    };

    it("an anomaly on an unheld symbol goes to candidate analysis, not reassessment", async () => {
        const { orch, ports } = build({
            loadObservations: async () => [{
                symbol: "UNHELD", bars1m: [...calm(40), bar("t", 140, 30000)], price: 140,
            }],
        });
        await orch.monitorCycle();
        await orch.reasoningCycle();
        expect(ports.analyseCandidate).toHaveBeenCalled();
        expect(ports.reassess).not.toHaveBeenCalled();
        expect(ports.execute).not.toHaveBeenCalled();
    });

    it("an anomaly on a held symbol goes to reassessment, not candidate analysis", async () => {
        const { orch, ports } = build({
            loadObservations: async () => [{
                symbol: "RELIANCE", bars1m: [...calm(40), bar("t", 140, 30000)], price: 140,
            }],
        });
        await orch.monitorCycle();
        await orch.reasoningCycle();
        expect(ports.reassess).toHaveBeenCalled();
        expect(ports.analyseCandidate).not.toHaveBeenCalled();
    });

    it("candidate analysis is suppressed when the session forbids discovery", async () => {
        const closing = istAt(15, 25);
        const ports = build().ports;
        ports.loadObservations = async () => [{
            symbol: "UNHELD", bars1m: [...calm(40), bar("t", 140, 30000)], price: 140 }];
        const orch = new Orchestrator({ ports, clock: () => closing });
        await orch.monitorCycle();
        await orch.reasoningCycle();
        expect(ports.analyseCandidate).not.toHaveBeenCalled();
    });

    it("candidate analysis cannot execute", async () => {
        const { orch, ports } = build({
            loadObservations: async () => [{
                symbol: "UNHELD", bars1m: [...calm(40), bar("t", 140, 30000)], price: 140,
            }],
            analyseCandidate: vi.fn(async () => ({ action: "BUY", confidence: "HIGH" })),
        });
        await orch.monitorCycle();
        await orch.reasoningCycle();
        expect(ports.execute).not.toHaveBeenCalled();
        expect(ports.journal).toHaveBeenCalledWith(
            expect.objectContaining({ executed: false, route: "CANDIDATE" }));
    });

    it("a simultaneous anomaly and news event both reach the queue", async () => {
        const store = new NewsStore();
        store.ingest([{ source: "s", sourceEventId: "n1", symbol: "RELIANCE",
                        subject: "Merger", disseminatedAt: istAt(11, 0).toISOString() }]);
        const { orch } = build({
            loadObservations: async () => [{
                symbol: "RELIANCE", bars1m: [...calm(40), bar("t", 140, 30000)], price: 140 }],
            pendingNewsEvents: async (now) => eventsForReasoning(store, now,
                { thesisBySymbol: new Map([["RELIANCE", "t-1"]]) }),
        });
        await orch.monitorCycle();
        expect(orch.health().metrics.anomaliesDetected).toBeGreaterThan(0);
        expect(orch.health().metrics.newsEventsReceived).toBe(1);
        expect(orch.queue.size).toBeGreaterThan(1);
    });

    it("repeated cycles do not re-queue an already recorded event", async () => {
        const seen = new Set();
        const { orch } = build({
            loadObservations: async () => [{
                symbol: "RELIANCE", bars1m: [...calm(40), bar("t", 140, 30000)], price: 140 }],
            recordEvent: async (e) => (seen.has(e.key) ? null : (seen.add(e.key), { id: e.key })),
        });
        await orch.monitorCycle();
        const first = orch.queue.size;
        await orch.monitorCycle();
        expect(orch.queue.size).toBe(first);
    });
});
