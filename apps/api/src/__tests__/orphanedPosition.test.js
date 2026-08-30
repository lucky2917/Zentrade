import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../services/orchestrator/orchestrator.js";
import { EVENT_TYPES, ROUTE, routeOf, requiresReasoning } from "../services/autonomous/events.js";
import { evaluatePosition } from "../services/autonomous/monitor.js";

// A holding with no open thesis. The manual trading path creates these: it
// writes an order and a position without ever forming a thesis, so anything
// bought by hand arrives in the autonomous loop unexplained.
//
// The loop cannot reassess such a position, cannot arm the reflex lane on it,
// and must not treat the report of that fact as a reason to buy more of it.

const OPEN_IST = new Date(Date.UTC(2026, 7, 31, 4, 30));   // 10:00 IST, a Monday

const orphaned = {
    symbol: "RELIANCE", quantity: 10, thesisId: null, hasThesis: false,
    stale: false, dataAgeMs: 0, currentPricePaise: 100_000,
    entryPricePaise: 100_000, unrealisedPnlPaise: 0, pnlPercent: 0,
    holdingSeconds: 60, stopDistance: null, targetDistance: null,
    correlationId: "manual-1",
};

describe("a position with no thesis", () => {
    it("is reported by the monitor", () => {
        const events = evaluatePosition(orphaned, { now: OPEN_IST });
        expect(events.map((e) => e.type)).toEqual([EVENT_TYPES.POSITION_WITHOUT_THESIS]);
        expect(events[0].severity).toBe("WARNING");
    });

    // The defect. Routing by "has no thesis id" made this look like a name we
    // are merely watching, which is the one thing it is not: we already hold it.
    it("is an infrastructure condition, not a candidate to buy", () => {
        const [event] = evaluatePosition(orphaned, { now: OPEN_IST });
        expect(routeOf(event)).toBe(ROUTE.INFRASTRUCTURE);
        expect(requiresReasoning(event)).toBe(false);
    });

    it("never reaches the candidate analyser", async () => {
        const analyseCandidate = vi.fn(async () => ({ action: "BUY", quantity: 5 }));
        const recorded = [];
        const orchestrator = new Orchestrator({
            clock: () => OPEN_IST,
            ports: {
                loadPositions: async () => [orphaned],
                loadPortfolio: async () => ({
                    userId: 1, grossExposurePaise: 1_000_000, unrealisedPnlPaise: 0 }),
                recordEvent: async (e) => { recorded.push(e); return { id: recorded.length }; },
                markEventHandled: async () => null,
                markEventFailed: async () => null,
                analyseCandidate,
            },
        });

        // With a price on hand the candidate path has everything it needs, so
        // nothing but the route itself keeps it away.
        orchestrator.lastContexts = { RELIANCE: { price: 1000 } };
        await orchestrator.monitorCycle();
        orchestrator.lastContexts = { RELIANCE: { price: 1000 } };
        await orchestrator.reasoningCycle();

        expect(recorded.map((e) => e.type)).toContain(EVENT_TYPES.POSITION_WITHOUT_THESIS);
        expect(analyseCandidate).not.toHaveBeenCalled();
    });

    it("is not queued for reasoning at all", async () => {
        const orchestrator = new Orchestrator({
            clock: () => OPEN_IST,
            ports: {
                loadPositions: async () => [orphaned],
                loadPortfolio: async () => null,
                recordEvent: async () => ({ id: 1 }),
                analyseCandidate: async () => ({ action: "HOLD" }),
            },
        });
        await orchestrator.monitorCycle();
        expect(orchestrator.queue.size).toBe(0);
        expect(orchestrator.metrics.reasoningAvoided).toBe(1);
    });

    it("still routes a real candidate signal to the analyser", async () => {
        const analyseCandidate = vi.fn(async () => ({ action: "HOLD", journaled: true }));
        const orchestrator = new Orchestrator({
            clock: () => OPEN_IST,
            ports: {
                loadPositions: async () => [],
                loadPortfolio: async () => null,
                recordEvent: async () => ({ id: 1 }),
                markEventHandled: async () => null,
                markEventFailed: async () => null,
                analyseCandidate,
            },
        });
        orchestrator.lastContexts = { INFY: { price: 1500 } };
        orchestrator.queue.offer({
            type: EVENT_TYPES.PRICE_JUMP, symbol: "INFY", thesisId: null,
            severity: "WARNING", reason: "moved 3%", storedId: 1,
        }, OPEN_IST.getTime());

        await orchestrator.reasoningCycle();
        expect(analyseCandidate).toHaveBeenCalledOnce();
    });
});
