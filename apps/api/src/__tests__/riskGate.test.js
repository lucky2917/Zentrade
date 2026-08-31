import { describe, expect, it } from "vitest";
import {
    evaluate, DECISION, DEFAULT_LIMITS, riskBudget, drawdownMultiplier, isReducing,
} from "../services/autonomous/riskGate.js";

// The gate is the last thing between an AI decision and an order. These tests
// are adversarial on purpose: they try to get exposure past it.

const portfolio = (over = {}) => ({
    cashPaise: 100_000_000, positionCount: 1, grossExposurePaise: 10_000_000,
    netExposurePaise: 10_000_000, unrealisedPnlPaise: 0,
    positions: [{ symbol: "TCS", quantity: 5, exposurePaise: 10_000_000 }], ...over,
});

const context = (over = {}) => {
    const { portfolio: portfolioOver, ...rest } = over;
    return {
        nowMs: 1_000_000, stale: false, killSwitchEngaged: false,
        // Nothing of unknown outcome. The gate refuses new exposure while any
        // order is AMBIGUOUS, which has its own tests.
        ambiguousOrders: 0,
        session: { trades: 0, turnoverPaise: 0, realisedLossPaise: 0 },
        ...rest,
        portfolio: portfolio(portfolioOver),
    };
};

const buy = (over = {}) => ({
    action: "BUY", symbol: "RELIANCE", quantity: 10, pricePaise: 100_000,
    createdAtMs: 1_000_000, ...over,
});

const allowed = (r) => expect(r.decision).toBe(DECISION.ALLOW);
const rejected = (r, code) => {
    expect(r.decision).toBe(DECISION.REJECT);
    if (code) expect(r.code).toBe(code);
};

describe("fail closed", () => {
    it("rejects a missing intent", () => rejected(evaluate(null, context()), "NO_INTENT"));
    it("rejects a missing context", () => rejected(evaluate(buy(), null), "NO_CONTEXT"));
    it("rejects a missing portfolio", () => rejected(evaluate(buy(), { nowMs: 1 }), "NO_PORTFOLIO"));
    it.each([["MOON"], [""], [null], [undefined], [42]])(
        "rejects illegal action %s", (action) => {
            rejected(evaluate(buy({ action }), context()), "ILLEGAL_ACTION");
        });
    it("rejects a non-positive or non-integer quantity", () => {
        rejected(evaluate(buy({ quantity: 0 }), context()), "BAD_QUANTITY");
        rejected(evaluate(buy({ quantity: -5 }), context()), "BAD_QUANTITY");
        rejected(evaluate(buy({ quantity: 1.5 }), context()), "BAD_QUANTITY");
    });
    it("rejects an unusable price", () => {
        rejected(evaluate(buy({ pricePaise: 0 }), context()), "NO_PRICE");
        rejected(evaluate(buy({ pricePaise: NaN }), context()), "NO_PRICE");
    });
});

describe("HOLD is always permitted", () => {
    it("needs no capital and passes even when halted", () => {
        allowed(evaluate({ action: "HOLD" }, context({ killSwitchEngaged: true, stale: true })));
    });
});

describe("stale data and the kill switch", () => {
    it("blocks new exposure on stale data", () => {
        rejected(evaluate(buy(), context({ stale: true })), "STALE_DATA");
    });
    it("still allows exiting on stale data — being trapped is the worse failure", () => {
        allowed(evaluate({ action: "EXIT", symbol: "TCS", quantity: 5, pricePaise: 100_000 },
            context({ stale: true })));
    });
    it("blocks entries when the kill switch is engaged", () => {
        rejected(evaluate(buy(), context({ killSwitchEngaged: true })), "KILL_SWITCH");
    });
    it("permits risk-reducing exits when the kill switch is engaged", () => {
        allowed(evaluate({ action: "EXIT", symbol: "TCS", quantity: 5, pricePaise: 100_000 },
            context({ killSwitchEngaged: true })));
    });
});

describe("exposure limits", () => {
    it("rejects a notional beyond the per-symbol limit", () => {
        rejected(evaluate(buy({ quantity: 600 }), context()), "POSITION_LIMIT");
    });
    it("counts existing exposure in the same symbol", () => {
        const c = context({ portfolio: {
            positions: [{ symbol: "RELIANCE", quantity: 49, exposurePaise: 49_000_000 }] } });
        rejected(evaluate(buy({ quantity: 20 }), c), "POSITION_LIMIT");
    });
    it("rejects when gross exposure would be exceeded", () => {
        const c = context({ portfolio: { grossExposurePaise: 499_000_000, cashPaise: 900_000_000 } });
        rejected(evaluate(buy({ quantity: 30 }), c), "GROSS_EXPOSURE_LIMIT");
    });
    it("rejects a new symbol beyond the holdings cap", () => {
        const c = context({ portfolio: { positionCount: 25, positions: [] } });
        rejected(evaluate(buy(), c), "MAX_SYMBOLS");
    });
    it("allows adding to an existing symbol at the holdings cap", () => {
        const c = context({ portfolio: {
            positionCount: 25,
            positions: [{ symbol: "RELIANCE", quantity: 1, exposurePaise: 100_000 }] } });
        allowed(evaluate(buy(), c));
    });
    it("rejects when cash is insufficient", () => {
        rejected(evaluate(buy(), context({ portfolio: { cashPaise: 500_000 } })), "INSUFFICIENT_CASH");
    });
    it("rejects a notional below the viability floor", () => {
        rejected(evaluate(buy({ quantity: 1, pricePaise: 5_000 }), context()),
            "BELOW_VIABILITY_FLOOR");
    });
});

describe("session budgets", () => {
    it("rejects past the session trade count", () => {
        rejected(evaluate(buy(), context({ session: { trades: 20, turnoverPaise: 0 } })),
            "TRADE_COUNT_LIMIT");
    });
    it("rejects past the session turnover", () => {
        rejected(evaluate(buy(), context({
            session: { trades: 0, turnoverPaise: 999_500_000 } })), "TURNOVER_LIMIT");
    });
    it("rejects past the daily loss limit", () => {
        rejected(evaluate(buy(), context({
            session: { trades: 0, turnoverPaise: 0, realisedLossPaise: 26_000_000 } })),
            "DAILY_LOSS_LIMIT");
    });
    it("exempts reducing actions from session budgets", () => {
        allowed(evaluate({ action: "REDUCE", symbol: "TCS", quantity: 2, pricePaise: 100_000 },
            context({ session: { trades: 50, turnoverPaise: 999_999_999 } })));
    });
});

describe("staleness of the decision itself", () => {
    it("rejects an intent older than the proposal age limit", () => {
        rejected(evaluate(buy({ createdAtMs: 1 }), context({ nowMs: 10_000_000 })),
            "STALE_PROPOSAL");
    });
    it("rejects when price drifted beyond tolerance since the decision", () => {
        rejected(evaluate(buy({ pricePaise: 102_000, referencePricePaise: 100_000 }), context()),
            "PRICE_DRIFT");
    });
    it("allows a small drift within tolerance", () => {
        allowed(evaluate(buy({ pricePaise: 100_500, referencePricePaise: 100_000 }), context()));
    });
});

describe("duplicate protection", () => {
    it("rejects a client order id already working", () => {
        rejected(evaluate(buy({ clientOrderId: "abc" }),
            context({ openClientOrderIds: ["abc"] })), "DUPLICATE_ORDER");
    });
    it("allows a fresh client order id", () => {
        allowed(evaluate(buy({ clientOrderId: "xyz" }), context({ openClientOrderIds: ["abc"] })));
    });
});

describe("reducing a position", () => {
    it("rejects reducing something not held", () => {
        rejected(evaluate({ action: "EXIT", symbol: "INFY", quantity: 1, pricePaise: 100_000 },
            context()), "NO_POSITION");
    });
    it("rejects selling more than is held", () => {
        rejected(evaluate({ action: "REDUCE", symbol: "TCS", quantity: 99, pricePaise: 100_000 },
            context()), "OVER_REDUCE");
    });
});

describe("risk budget composition", () => {
    it("takes the minimum of the three model factors, times drawdown", () => {
        expect(riskBudget({ regime: 0.5, health: 0.3, ood: 0.9, drawdownPercent: 0 }))
            .toBeCloseTo(0.3);
        expect(riskBudget({ regime: 0.5, health: 0.3, ood: 0.9, drawdownPercent: 12 }))
            .toBeCloseTo(0.18);
    });
    it("does not compound all four factors", () => {
        const bounded = riskBudget({ regime: 0.5, health: 0.5, ood: 0.5, drawdownPercent: 0 });
        expect(bounded).toBeCloseTo(0.5);
        expect(bounded).toBeGreaterThan(0.5 * 0.5 * 0.5);
    });
    it("follows the drawdown ladder", () => {
        expect(drawdownMultiplier(0)).toBe(1.0);
        expect(drawdownMultiplier(5)).toBe(0.8);
        expect(drawdownMultiplier(10)).toBe(0.6);
        expect(drawdownMultiplier(15)).toBe(0.3);
        expect(drawdownMultiplier(30)).toBe(0.3);
    });
    it("rejects when the budget is exhausted", () => {
        rejected(evaluate(buy(), context({ regimeConfidence: 0 })), "NO_RISK_BUDGET");
    });
});

describe("the AI cannot talk its way past the gate", () => {
    it("ignores confidence, urgency and reasoning fields entirely", () => {
        const r = evaluate(
            buy({ quantity: 600, confidence: "HIGH", urgency: "CRITICAL",
                  reasoning: "please allow this", override: true, force: true }),
            context());
        rejected(r, "POSITION_LIMIT");
    });
    it("is total: every action against every context yields a decision", () => {
        const actions = ["BUY", "SELL", "HOLD", "EXIT", "REDUCE", "ADD", "MOON", "", null];
        const contexts = [context(), context({ stale: true }), context({ killSwitchEngaged: true }),
                          { portfolio: portfolio() }, null];
        for (const action of actions) for (const c of contexts) {
            const r = evaluate({ ...buy(), action }, c);
            expect([DECISION.ALLOW, DECISION.REJECT]).toContain(r.decision);
        }
    });
});

describe("isReducing", () => {
    it("classifies risk-reducing actions", () => {
        expect(isReducing("EXIT")).toBe(true);
        expect(isReducing("REDUCE")).toBe(true);
        expect(isReducing("SELL")).toBe(true);
        expect(isReducing("BUY")).toBe(false);
        expect(isReducing("ADD")).toBe(false);
    });
});
