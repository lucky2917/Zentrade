import { describe, expect, it, vi } from "vitest";
import { runLoopCycle, intentFrom } from "../services/autonomous/loop.js";
import { DECISION } from "../services/autonomous/riskGate.js";

// End-to-end scenarios for the autonomous position loop, driven deterministically.
// These use the real monitor, real event contract, real guardrails and the real
// risk gate. Only the model, the database and execution are injected.

const NOW = new Date("2026-08-31T05:00:00Z");

const position = (over = {}) => ({
    symbol: "RELIANCE", userId: 1, side: "BUY", quantity: 10,
    entryPricePaise: 100000, currentPricePaise: 100000, exposurePaise: 1000000,
    stale: false, dataAgeMs: 1000, sessionPhase: "MID_SESSION",
    thesisId: "t-1", correlationId: "c-1", holdingSeconds: 3600,
    stopPaise: 95000, targetPaise: 110000,
    stopDistance: 1, targetDistance: 1, pnlPercent: 0,
    unrealisedPnlPaise: 0, hasThesis: true, ...over,
});

const portfolio = (over = {}) => ({
    userId: 1, cashPaise: 100_000_000, positionCount: 1,
    grossExposurePaise: 1_000_000, netExposurePaise: 1_000_000, unrealisedPnlPaise: 0,
    positions: [{ symbol: "RELIANCE", quantity: 10, exposurePaise: 1_000_000 }], ...over,
});

const thesisRow = {
    id: "t-1", side: "BUY", entry_price_paise: 100000, rationale: "breakout above 1000",
    setup_type: "breakout", invalidation_conditions: ["close below 990"],
    supporting_evidence: [], horizon: "INTRADAY", stop_paise: 95000, target_paise: 110000,
};

const ports = (over = {}) => ({
    recordEvent: vi.fn(async (e) => ({ id: `ev-${e.type}` })),
    loadThesis: vi.fn(async () => thesisRow),
    recordReassessment: vi.fn(async () => ({})),
    journal: vi.fn(async () => ({})),
    execute: vi.fn(async () => ({})),
    ...over,
});

const riskContext = { session: { trades: 0, turnoverPaise: 0, realisedLossPaise: 0 } };

describe("Scenario A — quiet position costs nothing", () => {
    it("emits no event, calls no model, places no order", async () => {
        const p = ports({ callModel: vi.fn() });
        const cycle = await runLoopCycle({
            positions: [position()], portfolio: portfolio(), riskContext, now: NOW, ports: p,
        });
        expect(cycle.eventsEmitted).toBe(0);
        expect(cycle.reasoningInvocations).toBe(0);
        expect(p.callModel).not.toHaveBeenCalled();
        expect(p.execute).not.toHaveBeenCalled();
    });
});

describe("Scenario B — crash triggers reassessment and exit", () => {
    it("detects the breach, reasons, passes risk, executes and journals", async () => {
        const callModel = vi.fn(async () => ({
            action: "EXIT", confidence: "HIGH", thesisStillValid: false,
            whatChanged: "invalidation condition hit", material: true,
            reasoning: "closed below the level recorded at entry", evidence: [],
        }));
        const p = ports({ callModel });

        const cycle = await runLoopCycle({
            positions: [position({ currentPricePaise: 94000, stopDistance: -0.2, pnlPercent: -6 })],
            portfolio: portfolio(), riskContext, now: NOW, ports: p,
        });

        expect(cycle.events.map((e) => e.type)).toContain("STOP_BREACH");
        expect(cycle.reasoningInvocations).toBe(1);
        expect(cycle.decisions[0].action).toBe("EXIT");
        expect(cycle.decisions[0].risk).toBe(DECISION.ALLOW);
        expect(cycle.executions).toBe(1);
        expect(p.execute).toHaveBeenCalledOnce();
        expect(p.recordReassessment).toHaveBeenCalledOnce();
        expect(p.journal).toHaveBeenCalledOnce();
    });
});

describe("Scenario C — good news, model holds", () => {
    it("reasons but places no order when the answer is HOLD", async () => {
        const p = ports({ callModel: vi.fn(async () => ({
            action: "HOLD", confidence: "HIGH", thesisStillValid: true,
            whatChanged: "moved toward target", material: false,
            reasoning: "thesis intact", evidence: [],
        })) });

        const cycle = await runLoopCycle({
            positions: [position({ currentPricePaise: 104000, stopDistance: 0.15, pnlPercent: 4 })],
            portfolio: portfolio(), riskContext, now: NOW, ports: p,
        });

        expect(cycle.reasoningInvocations).toBe(1);
        expect(cycle.intents).toBe(0);
        expect(p.execute).not.toHaveBeenCalled();
        expect(p.recordReassessment).toHaveBeenCalledOnce(); // HOLD is still journaled
    });
});

describe("Scenario F — malformed model output cannot cause an unsafe action", () => {
    it("falls back to HOLD and places no order", async () => {
        const p = ports({ callModel: vi.fn(async () => ({ action: "SELL EVERYTHING NOW" })) });
        const cycle = await runLoopCycle({
            positions: [position({ stopDistance: -0.2 })],
            portfolio: portfolio(), riskContext, now: NOW, ports: p,
        });
        expect(cycle.decisions[0].action).toBe("HOLD");
        expect(cycle.decisions[0].fallback).toBe(true);
        expect(p.execute).not.toHaveBeenCalled();
    });

    it("falls back when the model throws", async () => {
        const p = ports({ callModel: vi.fn(async () => { throw new Error("boom"); }) });
        const cycle = await runLoopCycle({
            positions: [position({ stopDistance: -0.2 })],
            portfolio: portfolio(), riskContext, now: NOW, ports: p,
        });
        expect(cycle.decisions[0].action).toBe("HOLD");
        expect(p.execute).not.toHaveBeenCalled();
    });
});

describe("Scenario G — risk gate refuses the AI", () => {
    it("blocks an ADD that breaches exposure and records the rejection", async () => {
        const p = ports({ callModel: vi.fn(async () => ({
            action: "ADD", confidence: "HIGH", thesisStillValid: true,
            whatChanged: "momentum", material: true, reasoning: "add", evidence: [],
        })) });

        const cycle = await runLoopCycle({
            positions: [position({ currentPricePaise: 94000, stopDistance: -0.2, quantity: 600 })],
            portfolio: portfolio({ cashPaise: 1000 }), riskContext, now: NOW, ports: p,
        });

        expect(cycle.intents).toBe(1);
        expect(cycle.riskRejections).toBe(1);
        expect(cycle.executions).toBe(0);
        expect(p.execute).not.toHaveBeenCalled();
        expect(p.recordReassessment).toHaveBeenCalledWith(
            expect.objectContaining({ riskDecision: DECISION.REJECT, executed: false }));
    });

    it("never lets the AI reach execution without the gate", async () => {
        const p = ports({ callModel: vi.fn(async () => ({
            action: "EXIT", confidence: "HIGH", thesisStillValid: false,
            whatChanged: "x", material: true, reasoning: "y", evidence: [],
        })) });
        await runLoopCycle({
            positions: [position({ stopDistance: -0.2 })],
            portfolio: portfolio({ positions: [] }), // position not in the book
            riskContext, now: NOW, ports: p,
        });
        // Gate rejects NO_POSITION, so nothing executes.
        expect(p.execute).not.toHaveBeenCalled();
    });
});

describe("Scenario H — duplicate events do not cause duplicate actions", () => {
    it("skips reasoning entirely when the event key was already recorded", async () => {
        const p = ports({ recordEvent: vi.fn(async () => null), callModel: vi.fn() });
        const cycle = await runLoopCycle({
            positions: [position({ stopDistance: -0.2 })],
            portfolio: portfolio(), riskContext, now: NOW, ports: p,
        });
        expect(cycle.eventsDeduped).toBeGreaterThan(0);
        expect(cycle.reasoningInvocations).toBe(0);
        expect(p.callModel).not.toHaveBeenCalled();
    });
});

describe("stale data and missing thesis short-circuit safely", () => {
    it("does not reason on stale data", async () => {
        const p = ports({ callModel: vi.fn() });
        const cycle = await runLoopCycle({
            positions: [position({ stale: true, stopDistance: -0.5 })],
            portfolio: portfolio(), riskContext, now: NOW, ports: p,
        });
        expect(cycle.events.map((e) => e.type)).toEqual(["DATA_STALE"]);
        expect(p.callModel).not.toHaveBeenCalled();
    });

    it("does not reason about a position with no thesis", async () => {
        const p = ports({ loadThesis: vi.fn(async () => null), callModel: vi.fn() });
        const cycle = await runLoopCycle({
            positions: [position({ hasThesis: false, thesisId: null, stopDistance: -0.5 })],
            portfolio: portfolio(), riskContext, now: NOW, ports: p,
        });
        expect(cycle.reasoningInvocations).toBe(0);
        expect(p.execute).not.toHaveBeenCalled();
    });
});

describe("intent construction", () => {
    it("produces no intent for HOLD", () => {
        expect(intentFrom({ action: "HOLD" }, position())).toBeNull();
    });
    it("exits the full position", () => {
        expect(intentFrom({ action: "EXIT" }, position()).quantity).toBe(10);
    });
    it("reduces by half, never below one share", () => {
        expect(intentFrom({ action: "REDUCE" }, position({ quantity: 10 })).quantity).toBe(5);
        expect(intentFrom({ action: "REDUCE" }, position({ quantity: 1 })).quantity).toBe(1);
    });
    it("carries a deterministic client order id for duplicate protection", () => {
        const a = intentFrom({ action: "EXIT" }, position());
        const b = intentFrom({ action: "EXIT" }, position());
        expect(a.clientOrderId).toBe(b.clientOrderId);
    });
});

describe("determinism", () => {
    it("produces an identical cycle summary for identical input", async () => {
        const build = () => runLoopCycle({
            positions: [position({ stopDistance: -0.2 })],
            portfolio: portfolio(), riskContext, now: NOW,
            ports: ports({ callModel: async () => ({
                action: "EXIT", confidence: "HIGH", thesisStillValid: false,
                whatChanged: "x", material: true, reasoning: "y", evidence: [] }) }),
        });
        const [a, b] = [await build(), await build()];
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
});
