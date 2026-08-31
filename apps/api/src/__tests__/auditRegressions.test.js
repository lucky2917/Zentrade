import { describe, expect, it, vi } from "vitest";
import { ReflexLane, CROSSING, DIRECTION } from "../services/tick/reflex.js";
import { evaluate, DECISION } from "../services/autonomous/riskGate.js";

// Regressions found in the end-to-end audit. Each names the failure it
// prevents rather than the code it exercises.

// ---- A. a protective exit that fails must stay armed ------------------------
//
// The latch is set when the crossing is detected, before the exit is attempted.
// Nothing cleared it when the exit failed, so one transient error disarmed the
// stop for the rest of the session while the position stayed open.

describe("a failed protective exit does not disarm the stop", () => {
    const commitment = () => ({
        thesisId: "t-1", direction: DIRECTION.LONG,
        stopPaise: 98_000, targetPaise: 108_000, quantity: 100, correlationId: "c-1",
    });

    it("re-fires the stop on the next tick after the handler failed", () => {
        const seen = [];
        const lane = new ReflexLane({
            clock: () => 1_000,
            onCrossing: (crossing) => {
                seen.push(crossing.kind);
                // The handler failed. It says so by clearing the latch.
                lane.rearm("RELIANCE", crossing.kind);
                return null;
            },
        });
        lane.arm("RELIANCE", commitment());

        lane.onTick({ symbol: "RELIANCE", pricePaise: 97_000, at: 1_000 });
        lane.onTick({ symbol: "RELIANCE", pricePaise: 96_500, at: 1_001 });

        expect(seen).toEqual([CROSSING.STOP, CROSSING.STOP]);
    });

    it("stays latched when the handler does not ask to retry", () => {
        const seen = [];
        const lane = new ReflexLane({
            clock: () => 1_000,
            onCrossing: (crossing) => { seen.push(crossing.kind); return null; },
        });
        lane.arm("RELIANCE", commitment());

        lane.onTick({ symbol: "RELIANCE", pricePaise: 97_000, at: 1_000 });
        lane.onTick({ symbol: "RELIANCE", pricePaise: 96_500, at: 1_001 });

        expect(seen).toEqual([CROSSING.STOP]);
    });

    it("rearm on an unarmed symbol is a no-op rather than an error", () => {
        const lane = new ReflexLane();
        expect(lane.rearm("NOTHING", CROSSING.STOP)).toBe(false);
    });
});

// The runtime's half of the same guarantee: whatever fails inside protect(),
// the level must still be armed when it returns.

describe("the runtime keeps the level armed through any protective failure", () => {
    const makeRuntime = async (ports) => {
        const { AutonomousRuntime, MODE } = await import("../services/autonomous/runtime.js");
        return new AutonomousRuntime({
            engine: { openOrders: async () => [] }, reconciler: null,
            mode: MODE.PAPER, userId: 1,
            ports: { loadPositions: async () => [], ...ports },
        });
    };

    const crossing = () => ({
        kind: CROSSING.STOP, symbol: "RELIANCE", pricePaise: 97_000, levelPaise: 98_000,
        thesisId: "t-1", correlationId: "c-1", quantity: 100, at: Date.now(),
    });

    // Driven through the lane's own dispatch, which is how it happens live:
    // the tick detects, the latch closes, and the handler runs afterwards.
    it("re-arms when the position cannot be read", async () => {
        const runtime = await makeRuntime({
            positionFor: async () => { throw new Error("database unreachable"); },
        });
        runtime.reflex.arm("RELIANCE", {
            thesisId: "t-1", direction: DIRECTION.LONG, stopPaise: 98_000,
            targetPaise: 108_000, quantity: 100, correlationId: "c-1",
        });

        const first = runtime.reflex.onTick({
            symbol: "RELIANCE", pricePaise: 97_000, at: Date.now() });
        expect(first).toHaveLength(1);
        await vi.waitFor(() => expect(runtime.metrics.protectiveRetries).toBe(1));

        // Still armed, and the level fires again rather than staying latched
        // with the position unguarded for the rest of the session.
        expect(runtime.reflex.isArmed("RELIANCE")).toBe(true);
        expect(runtime.reflex.onTick({
            symbol: "RELIANCE", pricePaise: 96_000, at: Date.now() })).toHaveLength(1);
        await vi.waitFor(() => expect(runtime.metrics.protectiveRetries).toBe(2));
    });

    it("re-arms when the exit cannot be submitted", async () => {
        const runtime = await makeRuntime({
            positionFor: async () => ({ symbol: "RELIANCE", quantity: 100 }),
        });
        runtime.venue.submit = async () => { throw new Error("engine refused"); };
        runtime.reflex.arm("RELIANCE", {
            thesisId: "t-1", direction: DIRECTION.LONG, stopPaise: 98_000,
            targetPaise: 108_000, quantity: 100, correlationId: "c-1",
        });
        expect((await runtime.protect(crossing())).rearmed).toBe(true);
        expect(runtime.reflex.isArmed("RELIANCE")).toBe(true);
    });

    it("disarms once, and only once, on a protective exit that worked", async () => {
        const submitted = [];
        const runtime = await makeRuntime({
            positionFor: async () => ({ symbol: "RELIANCE", quantity: 100 }),
        });
        runtime.venue.submit = async (intent) => {
            submitted.push(intent);
            return { order: { id: 1, state: "FILLED", symbol: "RELIANCE" }, duplicate: false };
        };
        runtime.reflex.arm("RELIANCE", {
            thesisId: "t-1", direction: DIRECTION.LONG, stopPaise: 98_000,
            targetPaise: 108_000, quantity: 100, correlationId: "c-1",
        });

        const result = await runtime.protect(crossing());
        expect(result).toEqual({ protected: true, quantity: 100 });
        expect(submitted).toHaveLength(1);
        expect(runtime.reflex.isArmed("RELIANCE")).toBe(false);
        expect(runtime.metrics.protectiveRetries).toBe(0);
    });

    it("stands down when the position is already gone", async () => {
        const runtime = await makeRuntime({ positionFor: async () => null });
        runtime.reflex.arm("RELIANCE", {
            thesisId: "t-1", direction: DIRECTION.LONG, stopPaise: 98_000,
            targetPaise: 108_000, quantity: 100, correlationId: "c-1",
        });
        const result = await runtime.protect(crossing());
        expect(result).toEqual({ protected: false, reason: "position already closed" });
        expect(runtime.reflex.isArmed("RELIANCE")).toBe(false);
    });
});

// ---- H. an order of unknown outcome must stop new exposure ------------------
//
// Reconciliation marks an order AMBIGUOUS when the venue's truth cannot be
// established: we do not know whether we own the position. Opening more
// exposure on top of that is the failure AMBIGUOUS exists to prevent, and the
// boot log claimed it was blocked while nothing enforced it.

describe("unresolved ambiguity blocks new exposure", () => {
    const portfolio = {
        cashPaise: 100_000_000, positions: [], positionCount: 0,
        grossExposurePaise: 0, netExposurePaise: 0,
    };
    const buy = {
        action: "BUY", symbol: "TCS", quantity: 10, pricePaise: 300_000,
        referencePricePaise: 300_000,
    };

    it("rejects a new position while an order's outcome is unknown", () => {
        const result = evaluate(buy, { portfolio, ambiguousOrders: 1 });
        expect(result.decision).toBe(DECISION.REJECT);
        expect(result.code).toBe("UNRESOLVED_AMBIGUITY");
    });

    it("still permits the exit that reduces the exposure", () => {
        const held = {
            ...portfolio,
            positions: [{ symbol: "TCS", quantity: 10, exposurePaise: 3_000_000 }],
            positionCount: 1,
        };
        const result = evaluate(
            { ...buy, action: "EXIT", side: "SELL" }, { portfolio: held, ambiguousOrders: 1 });
        expect(result.decision).toBe(DECISION.ALLOW);
    });

    it("allows a new position once nothing is ambiguous", () => {
        expect(evaluate(buy, { portfolio, ambiguousOrders: 0 }).decision).toBe(DECISION.ALLOW);
    });

    // Fail closed: an unevaluable count is not the same as zero.
    it("rejects when the ambiguity count could not be established", () => {
        const result = evaluate(buy, { portfolio, ambiguousOrders: null });
        expect(result.decision).toBe(DECISION.REJECT);
        expect(result.code).toBe("UNRESOLVED_AMBIGUITY");
    });
});
