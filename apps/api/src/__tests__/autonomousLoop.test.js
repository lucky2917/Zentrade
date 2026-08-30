import { describe, expect, it } from "vitest";
import { intentFrom, ACTION_TO_INTENT } from "../services/autonomous/loop.js";

// How a reassessment becomes an order intent.
//
// This file used to drive a second reasoning loop that lived in loop.js. That
// loop was superseded by the orchestrator's reasoningCycle and nothing called
// it, so it was removed. Everything it asserted about the DECISION path is
// covered against the real path in orchestrator.test.js, decisionInstant.test.js
// and cockpitLiveFlow.test.js; what survives here is the pure mapping that is
// still production code.

const position = (over = {}) => ({
    symbol: "RELIANCE", quantity: 10, currentPricePaise: 98_000,
    correlationId: "corr-1", ...over,
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

describe("only a reducing or adding action becomes an order", () => {
    it("maps every legal action exactly one way", () => {
        expect(ACTION_TO_INTENT).toEqual({
            EXIT: "SELL", REDUCE: "SELL", ADD: "BUY", HOLD: null });
    });

    it("produces nothing at all for HOLD", () => {
        expect(intentFrom({ action: "HOLD" }, position())).toBeNull();
    });

    it("refuses an action it does not recognise", () => {
        expect(intentFrom({ action: "SHORT" }, position())).toBeNull();
        expect(intentFrom({ action: "SELL EVERYTHING" }, position())).toBeNull();
    });
});
