import { describe, expect, it } from "vitest";
import {
    applyDecisionGuardrails, computeConsensus,
    DECISION_ACTIONS, CONFIDENCE_LEVELS,
} from "../services/aiEngine.js";

// The Indian agent's decision is part LLM and part fixed rules. These tests
// cover the fixed half: what the system does regardless of what the model
// says. HOLD is the abstention state, so "fails closed" means "lands on HOLD".

const consensusOf = (t, s, r) => computeConsensus(t, s, r);
const MARKET_CRASHING = -1;
const MARKET_CALM = 0;

describe("consensus is deterministic", () => {
    it("is unanimous only when all three agents agree", () => {
        expect(consensusOf("BULLISH", "BULLISH", "BULLISH").label).toBe("unanimous");
        expect(consensusOf("BEARISH", "BEARISH", "BEARISH").label).toBe("unanimous");
        expect(consensusOf("BULLISH", "BULLISH", "NEUTRAL").label).toBe("majority");
        expect(consensusOf("BULLISH", "BULLISH", "BEARISH").label).toBe("leaning");
    });

    it("returns a split with LOW confidence when the agents disagree evenly", () => {
        const c = consensusOf("BULLISH", "BEARISH", "NEUTRAL");
        expect(c.direction).toBe("NEUTRAL");
        expect(c.label).toBe("split");
        expect(c.impliedConfidence).toBe("LOW");
    });

    it("gives the same answer for the same inputs, every time", () => {
        const a = JSON.stringify(consensusOf("BULLISH", "NEUTRAL", "BEARISH"));
        for (let i = 0; i < 50; i += 1) {
            expect(JSON.stringify(consensusOf("BULLISH", "NEUTRAL", "BEARISH"))).toBe(a);
        }
    });

    it("never invents a direction the agents did not support", () => {
        const c = consensusOf("NEUTRAL", "NEUTRAL", "NEUTRAL");
        expect(c.direction).toBe("NEUTRAL");
        expect(c.bullish).toBe(0);
        expect(c.bearish).toBe(0);
    });
});

describe("guardrails coerce anything the model returns", () => {
    const bullish = consensusOf("BULLISH", "BULLISH", "NEUTRAL");

    it.each([
        ["a hallucinated action", "ACCUMULATE"],
        ["an empty string", ""],
        ["undefined", undefined],
        ["null", null],
        ["a lowercase action", "buy"],
        ["an injected sentence", "BUY the dip aggressively"],
    ])("replaces %s with a legal action", (_label, action) => {
        const out = applyDecisionGuardrails({ action }, bullish, MARKET_CALM);
        expect(DECISION_ACTIONS).toContain(out.action);
    });

    it("falls back to the consensus direction, not to a guess", () => {
        expect(applyDecisionGuardrails({ action: "???" }, bullish, MARKET_CALM).action).toBe("BUY");
        const bearish = consensusOf("BEARISH", "BEARISH", "NEUTRAL");
        expect(applyDecisionGuardrails({ action: "???" }, bearish, MARKET_CALM).action).toBe("SELL");
        const split = consensusOf("BULLISH", "BEARISH", "NEUTRAL");
        expect(applyDecisionGuardrails({ action: "???" }, split, MARKET_CALM).action).toBe("HOLD");
    });

    it("always produces a legal confidence level", () => {
        for (const confidence of ["VERY HIGH", "", undefined, 0.9, "certain"]) {
            const out = applyDecisionGuardrails({ action: "HOLD", confidence }, bullish, MARKET_CALM);
            expect(CONFIDENCE_LEVELS).toContain(out.confidence);
        }
    });

    it("keeps a confidence the model got right", () => {
        const out = applyDecisionGuardrails({ action: "BUY", confidence: "LOW" }, bullish, MARKET_CALM);
        expect(out.confidence).toBe("LOW");
    });
});

describe("macro override fails closed", () => {
    it("downgrades BUY to HOLD when the market is crashing and agreement is not unanimous", () => {
        const majority = consensusOf("BULLISH", "BULLISH", "NEUTRAL");
        const out = applyDecisionGuardrails({ action: "BUY" }, majority, MARKET_CRASHING);
        expect(out.action).toBe("HOLD");
    });

    it("allows BUY in a crashing market only on unanimous agreement", () => {
        const unanimous = consensusOf("BULLISH", "BULLISH", "BULLISH");
        const out = applyDecisionGuardrails({ action: "BUY" }, unanimous, MARKET_CRASHING);
        expect(out.action).toBe("BUY");
    });

    it("never upgrades: HOLD and SELL are untouched by the override", () => {
        const majority = consensusOf("BULLISH", "BULLISH", "NEUTRAL");
        expect(applyDecisionGuardrails({ action: "HOLD" }, majority, MARKET_CRASHING).action).toBe("HOLD");
        expect(applyDecisionGuardrails({ action: "SELL" }, majority, MARKET_CRASHING).action).toBe("SELL");
    });

    it("a hallucinated action in a crashing market lands on HOLD, not BUY", () => {
        const majority = consensusOf("BULLISH", "BULLISH", "NEUTRAL");
        const out = applyDecisionGuardrails({ action: "MOON" }, majority, MARKET_CRASHING);
        expect(out.action).toBe("HOLD");
    });
});

describe("the guardrails are total", () => {
    it("produces a legal decision for every combination of agent signals and market score", () => {
        const signals = ["BULLISH", "BEARISH", "NEUTRAL"];
        const junk = ["BUY", "SELL", "HOLD", "ACCUMULATE", "", undefined, null, 7];
        let checked = 0;
        for (const t of signals) for (const s of signals) for (const r of signals) {
            for (const mkt of [-1, 0, 1]) for (const action of junk) {
                const out = applyDecisionGuardrails({ action }, consensusOf(t, s, r), mkt);
                expect(DECISION_ACTIONS).toContain(out.action);
                checked += 1;
            }
        }
        expect(checked).toBe(3 * 3 * 3 * 3 * junk.length);
    });
});
