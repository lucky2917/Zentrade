import { describe, expect, it } from "vitest";
import { buildFormationPrompt, buildChallengePrompt } from "../services/reasoning/thesis.js";

// What the Senior Trader is actually told.
//
// Two sessions of persisted decisions showed the same two failures, and both
// were instruction failures rather than judgement failures:
//
//   · the model proposed BUY carrying a quantity and no stop or target, so the
//     proposal was discarded and became HOLD with the thesis work thrown away
//   · the challenger returned THESIS_WEAK or THESIS_BROKEN on 46 of 46
//     theses and THESIS_HOLDS on none, which makes the verdict carry no
//     information and applies the stricter weak-thesis floor universally
//
// These assert the instructions that address them are present. They cannot
// prove the model complies — only a live session does that — but they stop the
// instructions being silently lost in a later edit.

const state = {
    symbol: "TESTCO",
    symbolState: { price: 1000, vwap: 985, vwapDistance: 0.015 },
    market: { regime: "MIXED", breadth: "balanced" },
    evidence: [{ tier: "FACT", statement: "1m, 5m and 15m aligned up" }],
    risk: { cashPaise: 100_000_000, positionCount: 0 },
    position: null, trigger: { type: "screen" }, screenReasons: ["move 3.40%"],
    news: [], memories: [],
};

describe("the formation prompt requires a priced proposal", () => {
    const prompt = buildFormationPrompt(state);

    it("names all three numbers a BUY must carry", () => {
        expect(prompt).toMatch(/A BUY IS THREE NUMBERS OR IT IS NOT A BUY/);
        for (const field of ["stopRupees", "targetRupees", "quantity"]) {
            expect(prompt).toContain(field);
        }
    });

    it("says what happens to a BUY with a quantity and no levels", () => {
        expect(prompt).toMatch(/quantity but no stop is discarded and becomes HOLD/);
    });

    it("requires the target to clear costs by a margin, not scrape them", () => {
        expect(prompt).toMatch(/73\.55 bps/);
        expect(prompt).toMatch(/BELOW_COSTS/);
        expect(prompt).toMatch(/at least twice the distance to your stop/);
    });

    it("keeps HOLD available as a respectable answer", () => {
        expect(prompt).toMatch(/If you cannot name a stop, you do not have a thesis/);
        expect(prompt).toMatch(/Both are respectable answers/);
    });

    it("names the non-reasons it was refusing on", () => {
        for (const excuse of [/no news or fundamental catalyst/,
                              /market regime is unknown/,
                              /order-book depth is not visible/,
                              /could be" a false signal/,
                              /cannot quantify the expected move/]) {
            expect(prompt).toMatch(excuse);
        }
    });

    it("still tells it when to stand aside", () => {
        expect(prompt).toMatch(/Stand aside when the evidence genuinely does not converge/);
        expect(prompt).toMatch(/the move is too small to cover its costs/);
    });
});

describe("the challenge prompt asks for a verdict, not a reflex", () => {
    const thesis = { thesis: "aligned breakout holding above VWAP",
                     proposedAction: "BUY", supportingEvidence: ["alignment"] };
    const prompt = buildChallengePrompt(state, thesis);

    it("separates the verdict from the adversarial role", () => {
        expect(prompt).toMatch(/now step out of the adversarial role/);
        expect(prompt).toMatch(/the only part of your answer that is not adversarial/);
    });

    it("rejects the objections that apply to every trade ever", () => {
        expect(prompt).toMatch(/An objection you can raise against any trade/);
        expect(prompt).toMatch(/It does not make a thesis weak/);
    });

    it("calibrates the verdict against always answering the same way", () => {
        expect(prompt).toMatch(/your verdict carries\s+no information/);
        expect(prompt).toMatch(/HOLDS is the expected\s+outcome/);
        expect(prompt).toMatch(/WEAK and BROKEN are the\s+exceptions/);
    });

    it("still defines BROKEN as a genuine contradiction", () => {
        expect(prompt).toMatch(/evidence CONTRADICTS the thesis/);
        expect(prompt).toMatch(/Not "I found something to criticise"/);
    });

    it("tells it that WEAK has a price", () => {
        expect(prompt).toMatch(/raises the risk\/reward a trade must reach/);
    });

    it("keeps all three verdicts available", () => {
        for (const v of ["THESIS_HOLDS", "THESIS_WEAK", "THESIS_BROKEN"]) {
            expect(prompt).toContain(v);
        }
    });
});
