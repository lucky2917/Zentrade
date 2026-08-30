import { describe, expect, it, vi, beforeEach } from "vitest";

const groq = vi.hoisted(() => vi.fn());
vi.mock("../services/aiEngine.js", () => ({
    callGroqSafe: groq,
    MODELS: { synthesizer: "model-a", risk: "model-b" },
}));

const { makeCandidateAnalyser, makeReassessmentModel } =
    await import("../services/autonomous/reasoning.js");
const { reassessPosition, buildReassessmentContext } =
    await import("../services/autonomous/reassess.js");

const context = {
    asOf: "2026-09-01T06:30:00Z", sessionPhase: "MID_SESSION", minutesIntoSession: 165,
    price: 1000, vwap: 995, vwapDistance: 0.005, vwapAvailable: true,
    barsSeen: { m1: 46, m5: 10, m15: 4 },
    mtf: { complete: true, aligned: true, alignedDirection: "UP", conflict: false,
           direction1m: "UP", direction5m: "UP", direction15m: "UP",
           volatilityRatio: 1.1, volatilityExpanding: false, timeframesKnown: 3 },
};

const respond = (byLabel) => groq.mockImplementation(
    async (_model, _prompt, _temp, _tokens, sink, label) => {
        sink?.push({ agentName: label, modelId: _model, status: "ok" });
        return byLabel[label] ?? {};
    });

const goodThesis = {
    thesis: "range breakout holding above VWAP on expanding volume",
    setup: "breakout", direction: "LONG",
    supportingEvidence: ["price above session VWAP", "all three timeframes up"],
    contradictingEvidence: [], invalidationConditions: ["close below 990 on volume"],
    catalyst: "continuation of the morning trend", timeHorizon: "INTRADAY",
    uncertainty: [], proposedAction: "BUY",
    stopRupees: 990, targetRupees: 1025, quantity: 200,
};
const soundChallenge = {
    verdict: "THESIS_HOLDS", strongestObjection: "the move is already extended",
    alternativeHypotheses: [{ explanation: "short covering", supportedBy: "no news",
                             plausibility: "LOW" }],
    missingInformation: ["order book depth"], couldBeFalseSignal: false,
    whatWouldChangeTheDecision: ["a close back inside the range"],
    confirmationBiasDetected: false,
};

beforeEach(() => { groq.mockReset(); });

describe("candidate analyser routes through the senior pipeline", () => {
    it("makes exactly two model calls: form then challenge", async () => {
        respond({ senior_thesis_formation: goodThesis, senior_thesis_challenge: soundChallenge });
        await makeCandidateAnalyser()({ symbol: "RELIANCE", context, reasons: ["gap up"],
                                        correlationId: "c1", news: [], portfolio: null });
        expect(groq).toHaveBeenCalledTimes(2);
        expect(groq.mock.calls[0][5]).toBe("senior_thesis_formation");
        expect(groq.mock.calls[1][5]).toBe("senior_thesis_challenge");
        expect(groq.mock.calls[0][0]).toBe("model-a");
        expect(groq.mock.calls[1][0]).toBe("model-b");
    });

    it("passes the screen reasons into the formation prompt", async () => {
        respond({ senior_thesis_formation: goodThesis, senior_thesis_challenge: soundChallenge });
        await makeCandidateAnalyser()({ symbol: "RELIANCE", context,
                                        reasons: ["gap up", "volume surge"], correlationId: "c1" });
        expect(groq.mock.calls[0][1]).toContain("WHY THIS SYMBOL SURFACED");
        expect(groq.mock.calls[0][1]).toContain("volume surge");
    });

    it("gives the challenger the thesis it must break", async () => {
        respond({ senior_thesis_formation: goodThesis, senior_thesis_challenge: soundChallenge });
        await makeCandidateAnalyser()({ symbol: "RELIANCE", context, correlationId: "c1" });
        const prompt = groq.mock.calls[1][1];
        expect(prompt).toContain("BREAK the following thesis");
        expect(prompt).toContain("range breakout holding above VWAP");
    });

    it("returns every field livePorts.recordThesis reads", async () => {
        respond({ senior_thesis_formation: goodThesis, senior_thesis_challenge: soundChallenge });
        const d = await makeCandidateAnalyser()({ symbol: "RELIANCE", context, correlationId: "c1" });
        expect(d.action).toBe("BUY");
        expect(d.quantity).toBe(200);
        expect(d.setupType).toBe("breakout");
        expect(d.invalidationConditions).toEqual(["close below 990 on volume"]);
        expect(d.stopPaise).toBe(99000);
        expect(d.targetPaise).toBe(102500);
        expect(d.horizon).toBe("INTRADAY");
        expect(typeof d.reasoning).toBe("string");
        expect(d.reasoning.length).toBeGreaterThan(20);
        expect(Array.isArray(d.evidence)).toBe(true);
        expect(d.evidence.every((e) => e.tier && e.statement)).toBe(true);
        expect(d.correlationId).toBe("c1");
        expect(d.fallback).toBe(false);
    });

    it("carries the senior fields for the journal", async () => {
        respond({ senior_thesis_formation: goodThesis, senior_thesis_challenge: soundChallenge });
        const d = await makeCandidateAnalyser()({ symbol: "RELIANCE", context, correlationId: "c1" });
        expect(d.edge.verdict).toBe("CLEARS_COSTS");
        expect(d.alternativeHypotheses[0].explanation).toBe("short covering");
        expect(d.whatWouldChangeMyMind).toContain("a close back inside the range");
        expect(d.confidenceReason.length).toBeGreaterThan(0);
        expect(d.agentRuns).toHaveLength(2);
    });

    it("a transport failure is a safe HOLD, not a crash", async () => {
        groq.mockImplementation(async () => { throw new Error("groq 503"); });
        const d = await makeCandidateAnalyser()({ symbol: "X", context, correlationId: "c1" });
        expect(d.action).toBe("HOLD");
        expect(d.fallback).toBe(true);
        expect(d.reasoning).toMatch(/groq 503/);
    });

    it("BUY without a quantity degrades to HOLD", async () => {
        respond({ senior_thesis_formation: { ...goodThesis, quantity: null },
                  senior_thesis_challenge: soundChallenge });
        const d = await makeCandidateAnalyser()({ symbol: "X", context, correlationId: "c1" });
        expect(d.action).toBe("HOLD");
        expect(d.fallback).toBe(true);
    });

    it("an attractive thesis whose target cannot clear costs returns HOLD", async () => {
        respond({ senior_thesis_formation: { ...goodThesis, targetRupees: 1004 },
                  senior_thesis_challenge: soundChallenge });
        const d = await makeCandidateAnalyser()({ symbol: "X", context, correlationId: "c1" });
        expect(d.action).toBe("HOLD");
        expect(d.reasoning).toMatch(/73.55 bps/);
    });
});

describe("reassessment model round-trips through the existing guardrails", () => {
    const position = {
        symbol: "RELIANCE", currentPricePaise: 101000, unrealisedPnlPaise: 200000,
        pnlPercent: 1.0, quantity: 200, holdingSeconds: 1800, sessionPhase: "MID_SESSION",
        stopDistance: 0.8, targetDistance: 0.6, stale: false,
    };
    const thesis = {
        side: "BUY", entry_price_paise: 100000, rationale: "morning breakout",
        setup_type: "breakout", invalidation_conditions: ["close below 970"],
        supporting_evidence: [], horizon: "INTRADAY",
        stop_paise: 97000, target_paise: 110000,
    };
    const event = { type: "VOLUME_SPIKE", severity: "WARNING", reason: "volume 4x", observed: {} };

    const run = (formed, challenged) => {
        respond({ senior_reassess_formation: formed, senior_reassess_challenge: challenged });
        return reassessPosition({ position, thesis, event, marketState: context,
                                  portfolio: { cashPaise: 5000000, positionCount: 2 },
                                  callModel: makeReassessmentModel() });
    };

    it("produces a shape applyReassessmentGuardrails accepts", async () => {
        const r = await run({ thesis: "original thesis intact", proposedAction: "HOLD",
                              supportingEvidence: ["still above VWAP"], contradictingEvidence: [],
                              invalidationConditions: ["close below 970"], uncertainty: [] },
                            soundChallenge);
        expect(r.fallback).toBe(false);
        expect(r.action).toBe("HOLD");
        expect(r.thesisStillValid).toBe(true);
        expect(typeof r.whatChanged).toBe("string");
        expect(typeof r.material).toBe("boolean");
        expect(r.reassessmentCode).toBe("VOLUME_CHANGE");
    });

    it("asks whether the ORIGINAL thesis holds, not whether it would buy today", async () => {
        await run({ thesis: "t", proposedAction: "HOLD", invalidationConditions: ["x"] },
                  soundChallenge);
        const prompt = groq.mock.calls[0][1];
        expect(prompt).toContain("ORIGINAL THESIS (recorded at entry, immutable)");
        expect(prompt).toContain("Do not ask whether you would buy it today");
        expect(prompt).toContain("morning breakout");
    });

    it("a broken thesis becomes EXIT and is marked material", async () => {
        const r = await run({ thesis: "invalidation hit", proposedAction: "EXIT",
                              supportingEvidence: [], contradictingEvidence: ["closed below 970"],
                              invalidationConditions: ["close below 970"], uncertainty: [] },
                            { verdict: "THESIS_BROKEN", strongestObjection: "stop level gone" });
        expect(r.action).toBe("EXIT");
        expect(r.thesisStillValid).toBe(false);
        expect(r.material).toBe(true);
    });

    it("ADD on a thesis the model itself calls invalid is refused upstream", async () => {
        const r = await run({ thesis: "add more", proposedAction: "ADD",
                              supportingEvidence: [], contradictingEvidence: ["closed below 970"],
                              invalidationConditions: ["close below 970"], uncertainty: [] },
                            { verdict: "THESIS_BROKEN" });
        expect(r.action).not.toBe("ADD");
    });

    it("a transport failure surfaces as the existing safe fallback", async () => {
        groq.mockImplementation(async () => { throw new Error("groq down"); });
        const r = await reassessPosition({ position, thesis, event, marketState: context,
                                           callModel: makeReassessmentModel() });
        expect(r.action).toBe("HOLD");
        expect(r.fallback).toBe(true);
        expect(r.thesisStillValid).toBe(true);
        expect(r.reasoning).toMatch(/Safe fallback: model call failed: .*groq down/);
    });
});
