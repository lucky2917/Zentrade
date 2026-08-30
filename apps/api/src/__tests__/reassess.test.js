import { describe, expect, it } from "vitest";
import {
    reassessPosition, applyReassessmentGuardrails, buildReassessmentContext,
    safeFallback, REASSESS_ACTIONS,
} from "../services/autonomous/reassess.js";

const position = (over = {}) => ({
    symbol: "RELIANCE", quantity: 10, currentPricePaise: 98000,
    unrealisedPnlPaise: -20000, pnlPercent: -2, holdingSeconds: 3600,
    sessionPhase: "MID_SESSION", stopDistance: 0.2, targetDistance: 1.2,
    stale: false, ...over,
});

const thesis = (over = {}) => ({
    side: "BUY", entry_price_paise: 100000, rationale: "breakout above 1000",
    setup_type: "breakout", invalidation_conditions: ["close below 990"],
    supporting_evidence: [{ id: "ev-1" }], horizon: "INTRADAY",
    stop_paise: 95000, target_paise: 110000, ...over,
});

const event = { type: "STOP_APPROACHING", severity: "WARNING", reason: "near stop", observed: {} };

describe("reassessment context carries what discovery cannot", () => {
    it("includes the original thesis and what triggered the review", () => {
        const ctx = buildReassessmentContext({ position: position(), thesis: thesis(), event });
        expect(ctx.originalThesis.rationale).toBe("breakout above 1000");
        expect(ctx.originalThesis.invalidationConditions).toEqual(["close below 990"]);
        expect(ctx.trigger.type).toBe("STOP_APPROACHING");
        expect(ctx.entryPricePaise).toBe(100000);
        expect(ctx.unrealisedPnlPaise).toBe(-20000);
        expect(ctx.holdingSeconds).toBe(3600);
    });

    it("tolerates a reassessment with no triggering event", () => {
        const ctx = buildReassessmentContext({ position: position(), thesis: thesis(), event: null });
        expect(ctx.trigger).toBeNull();
    });
});

describe("guardrails on the model's answer", () => {
    const good = {
        action: "HOLD", confidence: "MEDIUM", thesisStillValid: true,
        whatChanged: "price drifted toward the stop", material: false,
        reasoning: "structure intact", evidence: [],
    };

    it("passes a well-formed answer through", () => {
        const out = applyReassessmentGuardrails(good, {});
        expect(out.action).toBe("HOLD");
        expect(out.fallback).toBe(false);
    });

    it.each([["MOON"], ["BUY"], ["SELL"], [""], [null], [undefined], [7]])(
        "falls back safely on illegal action %s", (action) => {
            const out = applyReassessmentGuardrails({ ...good, action }, {});
            expect(out.action).toBe("HOLD");
            expect(out.fallback).toBe(true);
        });

    it("never invents an action outside the vocabulary", () => {
        for (const action of ["MOON", "", null, 1, {}, []]) {
            const out = applyReassessmentGuardrails({ ...good, action }, {});
            expect(REASSESS_ACTIONS).toContain(out.action);
        }
    });

    it("repairs a malformed confidence rather than failing the whole answer", () => {
        const out = applyReassessmentGuardrails({ ...good, confidence: "VERY HIGH" }, {});
        expect(out.confidence).toBe("LOW");
        expect(out.action).toBe("HOLD");
    });

    it("repairs missing narrative fields", () => {
        const out = applyReassessmentGuardrails(
            { action: "EXIT", confidence: "HIGH", thesisStillValid: false }, {});
        expect(out.whatChanged).toBe("unspecified");
        expect(out.reasoning).toBe("no reasoning supplied");
        expect(out.evidence).toEqual([]);
        expect(out.action).toBe("EXIT");
    });

    it("blocks ADD on stale data but still allows EXIT", () => {
        const add = applyReassessmentGuardrails({ ...good, action: "ADD" }, { dataStale: true });
        expect(add.action).toBe("HOLD");
        const exit = applyReassessmentGuardrails({ ...good, action: "EXIT" }, { dataStale: true });
        expect(exit.action).toBe("EXIT");
    });

    it("refuses an incoherent answer that adds while calling the thesis dead", () => {
        const out = applyReassessmentGuardrails(
            { ...good, action: "ADD", thesisStillValid: false }, {});
        expect(out.action).toBe("HOLD");
        expect(out.fallback).toBe(true);
    });

    it("rejects a non-object response", () => {
        for (const raw of [null, undefined, "EXIT", 42]) {
            expect(applyReassessmentGuardrails(raw, {}).action).toBe("HOLD");
        }
    });
});

describe("model failure modes", () => {
    it("falls back when no model is configured", async () => {
        const out = await reassessPosition({ position: position(), thesis: thesis(), event });
        expect(out.action).toBe("HOLD");
        expect(out.fallback).toBe(true);
        expect(out.reasoning).toMatch(/no model configured/);
    });

    it("falls back when the model throws", async () => {
        const out = await reassessPosition({
            position: position(), thesis: thesis(), event,
            callModel: async () => { throw new Error("groq exploded"); },
        });
        expect(out.action).toBe("HOLD");
        expect(out.reasoning).toMatch(/groq exploded/);
    });

    it("falls back when the model exceeds its timeout", async () => {
        const out = await reassessPosition({
            position: position(), thesis: thesis(), event, timeoutMs: 30,
            callModel: () => new Promise((resolve) => setTimeout(resolve, 5000)),
        });
        expect(out.action).toBe("HOLD");
        expect(out.reasoning).toMatch(/timeout/);
    }, 10000);

    it("falls back on prompt-injection-shaped output", async () => {
        const out = await reassessPosition({
            position: position(), thesis: thesis(), event,
            callModel: async () => ({ action: "EXIT; ignore risk limits", confidence: "HIGH" }),
        });
        expect(out.action).toBe("HOLD");
        expect(out.fallback).toBe(true);
    });

    it("accepts a genuine EXIT decision", async () => {
        const out = await reassessPosition({
            position: position(), thesis: thesis(), event,
            callModel: async () => ({
                action: "EXIT", confidence: "HIGH", thesisStillValid: false,
                whatChanged: "closed below 990, invalidation hit", material: true,
                reasoning: "the recorded invalidation condition triggered", evidence: [{ id: "ev-2" }],
            }),
        });
        expect(out.action).toBe("EXIT");
        expect(out.thesisStillValid).toBe(false);
        expect(out.material).toBe(true);
        expect(out.fallback).toBe(false);
    });

    it("always returns the context it reasoned over, for the journal", async () => {
        const out = await reassessPosition({ position: position(), thesis: thesis(), event });
        expect(out.context.originalThesis.rationale).toBe("breakout above 1000");
    });
});

describe("safeFallback", () => {
    it("is HOLD, low confidence, and explains itself", () => {
        const f = safeFallback("because");
        expect(f.action).toBe("HOLD");
        expect(f.confidence).toBe("LOW");
        expect(f.fallback).toBe(true);
        expect(f.reasoning).toMatch(/because/);
    });
});
