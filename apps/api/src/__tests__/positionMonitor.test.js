import { describe, expect, it } from "vitest";
import {
    evaluatePosition, evaluatePortfolio, runMonitorCycle, DEFAULT_THRESHOLDS,
} from "../services/autonomous/monitor.js";
import {
    EVENT_TYPES, SEVERITY, ROUTE, routeOf, requiresReasoning, eventKey, makeEvent,
} from "../services/autonomous/events.js";

const NOW = new Date("2026-08-31T05:00:00Z");

const position = (over = {}) => ({
    symbol: "RELIANCE", userId: 1, side: "BUY", quantity: 10,
    entryPricePaise: 100000, currentPricePaise: 100000, exposurePaise: 1000000,
    stale: false, dataAgeMs: 1000, sessionPhase: "MID_SESSION",
    thesisId: "t-1", correlationId: "c-1", holdingSeconds: 600,
    stopPaise: 95000, targetPaise: 110000,
    stopDistance: 1, targetDistance: 1, pnlPercent: 0,
    unrealisedPnlPaise: 0, hasThesis: true, ...over,
});

const types = (events) => events.map((e) => e.type);

describe("quiet positions cost nothing", () => {
    it("emits no event when nothing has changed", () => {
        expect(evaluatePosition(position(), { now: NOW })).toHaveLength(0);
    });

    it("emits no event for a small drift below the jump threshold", () => {
        const events = evaluatePosition(
            position({ currentPricePaise: 100500, stopDistance: 0.9, targetDistance: 0.95 }),
            { previous: { currentPricePaise: 100000 }, now: NOW });
        expect(events).toHaveLength(0);
    });
});

describe("stop and target detection", () => {
    it("emits CRITICAL STOP_BREACH once the stop is crossed", () => {
        const events = evaluatePosition(position({ stopDistance: -0.1, pnlPercent: -5.5 }), { now: NOW });
        expect(types(events)).toContain(EVENT_TYPES.STOP_BREACH);
        expect(events[0].severity).toBe(SEVERITY.CRITICAL);
    });

    it("warns before the stop, not after", () => {
        const events = evaluatePosition(position({ stopDistance: 0.2 }), { now: NOW });
        expect(types(events)).toEqual([EVENT_TYPES.STOP_APPROACHING]);
        expect(events[0].severity).toBe(SEVERITY.WARNING);
    });

    it("does not warn while the stop is comfortably far", () => {
        expect(evaluatePosition(position({ stopDistance: 0.8 }), { now: NOW })).toHaveLength(0);
    });

    it("treats reaching the target as informational, not critical", () => {
        const events = evaluatePosition(position({ targetDistance: -0.05 }), { now: NOW });
        expect(types(events)).toContain(EVENT_TYPES.TARGET_BREACH);
        expect(events.find((e) => e.type === EVENT_TYPES.TARGET_BREACH).severity)
            .toBe(SEVERITY.WARNING);
    });

    it("emits nothing about levels the thesis never recorded", () => {
        const events = evaluatePosition(
            position({ stopPaise: null, targetPaise: null, stopDistance: null, targetDistance: null }),
            { now: NOW });
        expect(events).toHaveLength(0);
    });
});

describe("price jump detection", () => {
    it("fires on a move at or beyond the threshold", () => {
        const events = evaluatePosition(position({ currentPricePaise: 102500 }),
            { previous: { currentPricePaise: 100000 }, now: NOW });
        expect(types(events)).toContain(EVENT_TYPES.PRICE_JUMP);
    });

    it("escalates to CRITICAL on a move of twice the threshold", () => {
        const events = evaluatePosition(position({ currentPricePaise: 95000, stopDistance: 0.9 }),
            { previous: { currentPricePaise: 100000 }, now: NOW });
        const jump = events.find((e) => e.type === EVENT_TYPES.PRICE_JUMP);
        expect(jump.severity).toBe(SEVERITY.CRITICAL);
    });

    it("fires on a fall as readily as a rise", () => {
        const events = evaluatePosition(position({ currentPricePaise: 97500, stopDistance: 0.5 }),
            { previous: { currentPricePaise: 100000 }, now: NOW });
        expect(types(events)).toContain(EVENT_TYPES.PRICE_JUMP);
    });
});

describe("safety conditions short-circuit market evaluation", () => {
    it("reports stale data and stops, rather than reasoning on an untrusted price", () => {
        const events = evaluatePosition(position({ stale: true, dataAgeMs: 300000, stopDistance: -1 }),
            { now: NOW });
        expect(types(events)).toEqual([EVENT_TYPES.DATA_STALE]);
    });

    it("reports a position with no thesis and stops", () => {
        const events = evaluatePosition(position({ hasThesis: false, thesisId: null, stopDistance: -1 }),
            { now: NOW });
        expect(types(events)).toEqual([EVENT_TYPES.POSITION_WITHOUT_THESIS]);
    });
});

describe("deduplication by event key", () => {
    it("produces the same key for a persistent condition", () => {
        const a = evaluatePosition(position({ stopDistance: -0.1 }), { now: NOW })[0];
        const b = evaluatePosition(position({ stopDistance: -0.3 }),
            { now: new Date(NOW.getTime() + 30000) })[0];
        expect(a.key).toBe(b.key);
    });

    it("produces different keys as the position moves through approach bands", () => {
        const a = evaluatePosition(position({ stopDistance: 0.22 }), { now: NOW })[0];
        const b = evaluatePosition(position({ stopDistance: 0.05 }), { now: NOW })[0];
        expect(a.key).not.toBe(b.key);
    });

    it("scopes keys per symbol and per thesis", () => {
        expect(eventKey({ type: "STOP_BREACH", symbol: "A", thesisId: "t1", bucket: "x" }))
            .not.toBe(eventKey({ type: "STOP_BREACH", symbol: "B", thesisId: "t1", bucket: "x" }));
    });
});

describe("event routing", () => {
    const base = {
        symbol: "X", severity: SEVERITY.WARNING, correlationId: "c",
        source: "test", observed: {}, reason: "r", observedAt: NOW, bucket: "b",
    };
    it("routes an event with a thesis to the position loop", () => {
        expect(routeOf(makeEvent({ ...base, type: "STOP_BREACH", thesisId: "t-1" })))
            .toBe(ROUTE.POSITION);
    });
    it("routes the same type without a thesis to the candidate loop", () => {
        expect(routeOf(makeEvent({ ...base, type: "STOP_BREACH" }))).toBe(ROUTE.CANDIDATE);
    });
    it("keeps stale data as infrastructure, not market intelligence", () => {
        expect(routeOf(makeEvent({ ...base, type: "DATA_STALE", thesisId: "t-1" })))
            .toBe(ROUTE.INFRASTRUCTURE);
    });
    it("routes portfolio drawdown to the market loop", () => {
        expect(routeOf(makeEvent({ ...base, type: "PORTFOLIO_DRAWDOWN" }))).toBe(ROUTE.MARKET);
    });
});

describe("which events are worth an LLM call", () => {
    const ev = (type, severity, thesisId) => makeEvent({
        type, severity, thesisId, symbol: "X", correlationId: "c", source: "t",
        observed: {}, reason: "r", observedAt: NOW, bucket: "b",
    });
    it("wakes reasoning for a critical position event", () => {
        expect(requiresReasoning(ev("STOP_BREACH", SEVERITY.CRITICAL, "t-1"))).toBe(true);
    });
    it("does not wake reasoning for an informational event", () => {
        expect(requiresReasoning(ev("TARGET_APPROACHING", SEVERITY.INFO, "t-1"))).toBe(false);
    });
    it("does not wake position reasoning for infrastructure", () => {
        expect(requiresReasoning(ev("DATA_STALE", SEVERITY.WARNING, "t-1"))).toBe(false);
    });
});

describe("portfolio drawdown", () => {
    it("fires past the configured drawdown", () => {
        const events = evaluatePortfolio({
            userId: 1, grossExposurePaise: 1000000, unrealisedPnlPaise: -60000,
        }, { now: NOW });
        expect(types(events)).toEqual([EVENT_TYPES.PORTFOLIO_DRAWDOWN]);
    });
    it("stays quiet within it", () => {
        expect(evaluatePortfolio({
            userId: 1, grossExposurePaise: 1000000, unrealisedPnlPaise: -20000,
        }, { now: NOW })).toHaveLength(0);
    });
    it("does not divide by zero on an empty book", () => {
        expect(evaluatePortfolio({ userId: 1, grossExposurePaise: 0, unrealisedPnlPaise: 0 },
            { now: NOW })).toHaveLength(0);
    });
});

describe("monitor cycle", () => {
    it("evaluates every position and the portfolio in one pass", () => {
        const events = runMonitorCycle({
            positions: [position({ symbol: "A", stopDistance: -0.1 }), position({ symbol: "B" })],
            portfolio: { userId: 1, grossExposurePaise: 1000000, unrealisedPnlPaise: -70000 },
            now: NOW,
        });
        expect(types(events).sort()).toEqual(
            [EVENT_TYPES.PORTFOLIO_DRAWDOWN, EVENT_TYPES.STOP_BREACH].sort());
    });

    it("is deterministic for identical input", () => {
        const input = () => ({
            positions: [position({ stopDistance: 0.1 })],
            portfolio: { userId: 1, grossExposurePaise: 1000000, unrealisedPnlPaise: -80000 },
            now: NOW,
        });
        expect(JSON.stringify(runMonitorCycle(input())))
            .toBe(JSON.stringify(runMonitorCycle(input())));
    });

    it("rejects an unknown event type at construction", () => {
        expect(() => makeEvent({
            type: "NOT_A_TYPE", severity: SEVERITY.INFO, symbol: "X",
            correlationId: "c", source: "t", observed: {}, reason: "r", observedAt: NOW,
        })).toThrow(/unknown event type/);
    });
});
