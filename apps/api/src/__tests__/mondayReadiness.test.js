import { describe, expect, it, vi } from "vitest";
import { ConnectionTracker, CONNECTION } from "../services/orchestrator/connectionState.js";
import { makeEvent, eventKey, sessionDateOf } from "../services/autonomous/events.js";
import { observationStale } from "../services/autonomous/livePorts.js";
import { STALE_AFTER_MS } from "../services/autonomous/positionState.js";
import { Orchestrator } from "../services/orchestrator/orchestrator.js";

describe("connection trust is evaluated, not remembered", () => {
    const make = (now) => new ConnectionTracker({ clock: () => now.value });

    it("a socket that connects and never delivers a tick goes STALE", () => {
        const now = { value: 1_000_000 };
        const c = make(now);
        c.onConnecting(); c.onConnected();
        expect(c.isTrusted()).toBe(true);
        now.value += 91_000;
        expect(c.isTrusted()).toBe(false);
        expect(c.state).toBe(CONNECTION.STALE);
    });

    it("isTrusted evaluates without the caller remembering to", () => {
        const now = { value: 1_000_000 };
        const c = make(now);
        c.onConnecting(); c.onConnected(); c.onTick(now.value);
        now.value += 91_000;
        // No explicit evaluate() call: this is exactly how livePorts uses it.
        expect(c.isTrusted()).toBe(false);
    });

    it("a fresh tick keeps it trusted", () => {
        const now = { value: 1_000_000 };
        const c = make(now);
        c.onConnecting(); c.onConnected();
        for (let i = 0; i < 5; i += 1) {
            now.value += 30_000; c.onTick(now.value);
            expect(c.isTrusted()).toBe(true);
        }
    });

    it("recovers when ticks resume", () => {
        const now = { value: 1_000_000 };
        const c = make(now);
        c.onConnecting(); c.onConnected(); c.onTick(now.value);
        now.value += 91_000;
        expect(c.isTrusted()).toBe(false);
        c.onTick(now.value);
        expect(c.isTrusted()).toBe(true);
    });
});

describe("observation staleness is measured, not assumed", () => {
    const now = Date.parse("2026-08-31T04:00:00Z");

    it("a weekend-old cached tick is stale even though it exists", () => {
        // The exact production condition: stock:SYMBOL has no TTL, so Friday's
        // close is still sitting there on Monday morning.
        const friday = { price: 1000, timestamp: new Date(now - 25 * 3600_000).toISOString() };
        expect(observationStale(friday, now, true)).toBe(true);
    });

    it("a fresh tick on a trusted connection is not stale", () => {
        const fresh = { price: 1000, timestamp: new Date(now - 5_000).toISOString() };
        expect(observationStale(fresh, now, true)).toBe(false);
    });

    it("a fresh tick on an untrusted connection is stale", () => {
        const fresh = { price: 1000, timestamp: new Date(now - 5_000).toISOString() };
        expect(observationStale(fresh, now, false)).toBe(true);
    });

    it("a missing or undated tick is stale", () => {
        expect(observationStale(null, now, true)).toBe(true);
        expect(observationStale({ price: 1000 }, now, true)).toBe(true);
    });

    it("uses the same bound as position state", () => {
        const edge = { price: 1000, timestamp: new Date(now - STALE_AFTER_MS - 1).toISOString() };
        const inside = { price: 1000, timestamp: new Date(now - STALE_AFTER_MS + 1000).toISOString() };
        expect(observationStale(edge, now, true)).toBe(true);
        expect(observationStale(inside, now, true)).toBe(false);
    });
});

describe("event identity is scoped to the trading session", () => {
    const mk = (at, over = {}) => makeEvent({
        type: "PRICE_JUMP", symbol: "RELIANCE", severity: "WARNING",
        correlationId: "c", source: "anomaly_engine", observed: {},
        reason: "moved 3%", observedAt: at, bucket: "pwarning", ...over });

    it("the same condition twice in one session is one event", () => {
        expect(mk(new Date("2026-08-31T05:00:00Z")).key)
            .toBe(mk(new Date("2026-08-31T09:00:00Z")).key);
    });

    it("the same condition on the next session is a new event", () => {
        expect(mk(new Date("2026-08-31T05:00:00Z")).key)
            .not.toBe(mk(new Date("2026-09-01T05:00:00Z")).key);
    });

    it("rolls over on the IST day, not the UTC day", () => {
        // 18:45 UTC Monday is 00:15 IST Tuesday.
        expect(sessionDateOf(new Date("2026-08-31T18:45:00Z"))).toBe("2026-09-01");
        expect(sessionDateOf(new Date("2026-08-31T18:15:00Z"))).toBe("2026-08-31");
    });

    it("severity escalation still supersedes within a session", () => {
        const warning = mk(new Date("2026-08-31T05:00:00Z"));
        const critical = mk(new Date("2026-08-31T05:01:00Z"),
                            { severity: "CRITICAL", bucket: "pcritical" });
        expect(warning.key).not.toBe(critical.key);
    });

    it("stays inside the event_key column width with a thesis id", () => {
        const key = eventKey({ sessionDate: "2026-08-31", type: "STOP_APPROACHING",
            symbol: "BAJFINANCE", thesisId: "0f9c2b1e-6d3a-4c8b-9f11-2a7d5e8c4b60", bucket: "2" });
        expect(key.length).toBeLessThanOrEqual(128);
    });
});

describe("anomaly-driven candidates carry their context", () => {
    const baseEvent = {
        key: "k", type: "PRICE_JUMP", symbol: "RELIANCE", severity: "WARNING",
        thesisId: null, correlationId: "c", reason: "3 sigma", observed: {},
        observedAt: "2026-08-31T05:00:00Z",
    };

    const orchestratorWith = (analyseCandidate, contexts) => {
        const o = new Orchestrator({
            clock: () => new Date("2026-08-31T05:00:00Z"),
            ports: { analyseCandidate, journal: async () => {} },
        });
        o.lastContexts = contexts;
        return o;
    };

    it("passes the observed context so sizing is possible", async () => {
        const analyse = vi.fn(async () => ({ action: "HOLD" }));
        const o = orchestratorWith(analyse, { RELIANCE: { price: 1000, sessionPhase: "OPEN" } });
        await o.handleEvent(baseEvent, "corr", "OPEN");
        expect(analyse).toHaveBeenCalledOnce();
        expect(analyse.mock.calls[0][0].context.price).toBe(1000);
        expect(analyse.mock.calls[0][0].reasons[0]).toMatch(/PRICE_JUMP/);
    });

    it("spends no reasoning call when there is no usable context", async () => {
        const analyse = vi.fn(async () => ({ action: "BUY" }));
        const o = orchestratorWith(analyse, {});
        const result = await o.handleEvent(baseEvent, "corr", "OPEN");
        expect(analyse).not.toHaveBeenCalled();
        expect(result.skipped).toMatch(/no observed context/);
        expect(o.metrics.reasoningAvoided).toBe(1);
    });

    it("still refuses discovery when the session forbids it", async () => {
        const analyse = vi.fn(async () => ({ action: "BUY" }));
        const o = orchestratorWith(analyse, { RELIANCE: { price: 1000 } });
        const result = await o.handleEvent(baseEvent, "corr", "CLOSING");
        expect(analyse).not.toHaveBeenCalled();
        expect(result.skipped).toMatch(/session forbids discovery/);
    });
});

// F28 (found in the second red-team pass). The websocket and the REST market
// worker both write `stock:SYMBOL`. A consumer that cannot tell them apart
// reads a five-minute-old REST quote as if it were a live tick, which defeats
// the staleness protection for held positions.
describe("a REST quote is not a live tick", () => {
    const now = Date.parse("2026-08-31T05:00:00Z");

    it("judges a streamed tick by the streaming bound", async () => {
        const { maxAgeForTick, STALE_AFTER_MS } =
            await import("../services/autonomous/positionState.js");
        expect(maxAgeForTick({ source: "websocket" })).toBe(STALE_AFTER_MS);
        expect(maxAgeForTick({})).toBe(STALE_AFTER_MS);   // unstamped defaults to strict
    });

    it("judges a REST quote by the REST bound", async () => {
        const { maxAgeForTick } = await import("../services/autonomous/positionState.js");
        const { maxAgeFor, SOURCE } = await import("../services/orchestrator/freshness.js");
        expect(maxAgeForTick({ source: "rest" })).toBe(maxAgeFor(SOURCE.REST));
    });

    it("a REST quote refreshed while the stream is dead is still stale", async () => {
        const { observationStale } = await import("../services/autonomous/livePorts.js");
        const restQuote = { price: 1000, source: "rest",
                            timestamp: new Date(now - 5_000).toISOString() };
        // Fresh by its own bound, but the connection is not trusted.
        expect(observationStale(restQuote, now, false)).toBe(true);
        expect(observationStale(restQuote, now, true)).toBe(false);
    });

    it("a two-minute-old streamed tick is stale even though a REST quote would not be", async () => {
        const { observationStale } = await import("../services/autonomous/livePorts.js");
        const streamed = { price: 1000, source: "websocket",
                           timestamp: new Date(now - 120_000).toISOString() };
        expect(observationStale(streamed, now, true)).toBe(true);
    });
});
