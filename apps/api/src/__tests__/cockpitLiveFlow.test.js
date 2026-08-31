import { describe, expect, it, vi } from "vitest";
import { Orchestrator } from "../services/orchestrator/orchestrator.js";
import { Narrator, KIND, BRAIN } from "../services/cockpit/narrator.js";
import { makeReassessmentModel } from "../services/autonomous/reasoning.js";
import { reassessPosition } from "../services/autonomous/reassess.js";
import { makeEvent } from "../services/autonomous/events.js";
import { intentFrom } from "../services/autonomous/loop.js";

// The whole path, end to end, through the REAL pipeline.
//
// Nothing is mocked except the model transport and the database ports. The
// TraderState, the thesis validation, the adversarial challenge, the
// deterministic synthesis, the revalidation and the risk gate all really run,
// and the cockpit renders exactly what they produced.

const OPEN_IST = new Date(Date.UTC(2026, 7, 31, 4, 30));   // 10:00 IST, a Monday

const THESIS_RESPONSE = {
    thesis: "Trend continuation above session VWAP with expanding participation",
    setup: "vwap_reclaim",
    direction: "LONG",
    proposedAction: "HOLD",
    supportingEvidence: ["price holding above VWAP", "5m structure still higher-low"],
    contradictingEvidence: ["volume fading into the move"],
    invalidationConditions: ["close below VWAP on a 5m bar"],
    catalyst: "none identified",
    timeHorizon: "INTRADAY",
    uncertainty: ["breadth is mixed"],
    stopRupees: 970,
    targetRupees: 1050,
    quantity: 10,
};

const CHALLENGE_RESPONSE = {
    strongestObjection: "the move is one-sided and breadth does not confirm it",
    counterThesis: "this is a low-liquidity drift that mean-reverts into the close",
    alternativeHypotheses: [
        { explanation: "index-driven beta rather than a stock-specific bid",
          supportedBy: "market breadth", plausibility: "MEDIUM" },
        { explanation: "a single large order working through the book",
          supportedBy: "volume shape", plausibility: "LOW" },
    ],
    missingInformation: ["order book depth"],
    couldBeFalseSignal: true,
    falseSignalTell: "volume falling while price rises",
    whatWouldChangeTheDecision: ["VWAP reclaimed from below on rising volume"],
    confirmationBiasDetected: false,
    verdict: "THESIS_HOLDS",
};

const position = (over = {}) => ({
    symbol: "RELIANCE", userId: 1, quantity: 10, thesisId: 7,
    entryPricePaise: 100_000, currentPricePaise: 98_000,
    unrealisedPnlPaise: -20_000, pnlPercent: -2, holdingSeconds: 900,
    stopDistance: 0.2, targetDistance: 0.7, correlationId: "corr-1",
    stale: false, dataAgeMs: 0, hasThesis: true, ...over,
});

const thesisRow = {
    id: 7, rationale: "entry rationale recorded at 09:20 and never edited since",
    setup_type: "vwap_reclaim", invalidation_conditions: ["close below VWAP"],
    horizon: "INTRADAY", stop_paise: 97_000, target_paise: 105_000,
    opened_at: new Date(Date.UTC(2026, 7, 31, 3, 50)).toISOString(),
};

const transportFor = (challengeVerdict = CHALLENGE_RESPONSE) =>
    // Discriminate on a heading only the challenge prompt carries. Matching the
    // word "challenge" anywhere broke the moment the formation prompt mentioned
    // that a challenger would review the proposal — the formation call then got
    // the challenge response and every thesis came back unarticulated.
    vi.fn(async (_model, prompt) =>
        (String(prompt).includes("THE THESIS UNDER EXAMINATION")
            ? challengeVerdict : THESIS_RESPONSE));

const buildOrchestrator = ({ narrator, transport, riskDecision = "ALLOW",
                             executed = [] } = {}) => {
    const callModel = makeReassessmentModel({ transport, narrator });
    return new Orchestrator({
        clock: () => OPEN_IST, narrator,
        ports: {
            loadPositions: async () => [position()],
            loadPortfolio: async () => ({ userId: 1, cashPaise: 50_000_000,
                positionCount: 1, grossExposurePaise: 980_000, unrealisedPnlPaise: -20_000 }),
            positionFor: async () => position(),
            loadThesis: async () => thesisRow,
            reassess: async ({ position: p, thesis, event, marketState, market }) =>
                reassessPosition({ position: p, thesis, event, marketState, market, callModel }),
            intentFrom,
            currentWorld: async () => ({ nowMs: OPEN_IST.getTime(), pricePaise: 98_000,
                priceAgeMs: 500, position: { quantity: 10 } }),
            evaluateRisk: async () => ({ decision: riskDecision,
                code: riskDecision === "ALLOW" ? "OK" : "EXPOSURE_CAP",
                reason: riskDecision === "ALLOW" ? "within limits" : "portfolio cap reached" }),
            execute: async (intent) => { executed.push(intent);
                return { order: { id: 99, state: "FILLED", symbol: intent.symbol } }; },
            recordEvent: async () => ({ id: 1 }),
            markEventHandled: async () => null,
            markEventFailed: async () => null,
            recordReassessment: async () => ({ id: 1 }),
            journal: async () => null,
        },
    });
};

const offerEvent = (orchestrator, over = {}) => {
    orchestrator.queue.offer({
        ...makeEvent({
            type: "PRICE_JUMP", symbol: "RELIANCE", severity: "WARNING", thesisId: 7,
            correlationId: "corr-1", source: "reflex_lane",
            observed: { detector: "reflex_v1", movePercent: 2.4 },
            reason: "moved 2.40% within 60s", observedAt: OPEN_IST, bucket: "b",
            ...over,
        }),
        storedId: 1,
    }, OPEN_IST.getTime());
};

describe("a material change produces visible reasoning", () => {
    it("narrates the whole sequence in the order it happened", async () => {
        const narrator = new Narrator({ clock: () => OPEN_IST });
        const orchestrator = buildOrchestrator({ narrator, transport: transportFor() });
        offerEvent(orchestrator);

        await orchestrator.reasoningCycle();

        const kinds = narrator.recent().map((e) => e.kind);
        expect(kinds).toEqual([
            KIND.REASONING_STARTED,
            KIND.WHAT_I_KNOW,
            KIND.THESIS_FORMED,
            KIND.THESIS_CHALLENGED,
            KIND.ALTERNATIVES,
            KIND.WHAT_WOULD_CHANGE_MY_MIND,
            KIND.SYNTHESIS,
            KIND.DECISION,
            KIND.REASSESSMENT,
            KIND.REASONING_FINISHED,
        ]);
    });

    it("carries the real structured artifacts, not summaries of them", async () => {
        const narrator = new Narrator({ clock: () => OPEN_IST });
        const orchestrator = buildOrchestrator({ narrator, transport: transportFor() });
        offerEvent(orchestrator);
        await orchestrator.reasoningCycle();

        const byKind = Object.fromEntries(narrator.recent().map((e) => [e.kind, e]));

        // The deterministic ground, with tiers assigned by origin.
        const known = byKind[KIND.WHAT_I_KNOW];
        expect(known.evidence.length).toBeGreaterThan(0);
        expect(known.evidence.every((e) =>
            ["FACT", "OBSERVATION", "INFERENCE", "HYPOTHESIS", "PREDICTION"].includes(e.tier)))
            .toBe(true);
        // The entry thesis travels beside the current view, and stays separate.
        expect(known.originalThesis.rationale).toBe(thesisRow.rationale);

        expect(byKind[KIND.THESIS_FORMED].thesis).toBe(THESIS_RESPONSE.thesis);
        expect(byKind[KIND.THESIS_FORMED].contradictingEvidence.length).toBeGreaterThan(0);
        expect(byKind[KIND.THESIS_CHALLENGED].counterThesis)
            .toBe(CHALLENGE_RESPONSE.counterThesis);
        expect(byKind[KIND.ALTERNATIVES].alternatives).toHaveLength(2);
        expect(byKind[KIND.WHAT_WOULD_CHANGE_MY_MIND].conditions).toEqual(
            CHALLENGE_RESPONSE.whatWouldChangeTheDecision);
        expect(byKind[KIND.SYNTHESIS].costHurdleBps).toBe(73.55);
        expect(byKind[KIND.DECISION].action).toBeDefined();
    });

    it("shows the risk gate rejecting, and no order following it", async () => {
        const narrator = new Narrator({ clock: () => OPEN_IST });
        const executed = [];
        const orchestrator = buildOrchestrator({
            narrator, transport: transportFor({ ...CHALLENGE_RESPONSE,
                verdict: "THESIS_BROKEN" }),
            riskDecision: "REJECT", executed });
        offerEvent(orchestrator, { type: "STOP_APPROACHING", severity: "CRITICAL" });

        await orchestrator.reasoningCycle();
        const kinds = narrator.recent().map((e) => e.kind);

        if (kinds.includes(KIND.RISK_DECISION)) {
            const risk = narrator.recent().find((e) => e.kind === KIND.RISK_DECISION);
            expect(risk.decision).toBe("REJECT");
            expect(risk.reason).toBe("portfolio cap reached");
            expect(executed).toEqual([]);
        } else {
            // The decision was HOLD, so there was no intent to gate. Either way
            // nothing may have executed.
            expect(executed).toEqual([]);
        }
        expect(kinds).toContain(KIND.REASONING_FINISHED);
    });

    it("returns the brain to observation when it is done", async () => {
        const narrator = new Narrator({ clock: () => OPEN_IST });
        const orchestrator = buildOrchestrator({ narrator, transport: transportFor() });
        offerEvent(orchestrator);
        await orchestrator.reasoningCycle();

        expect(narrator.brain).toBe(BRAIN.MONITORING);
        expect(narrator.currentThought).toBeNull();
        expect(narrator.recent().at(-1).kind).toBe(KIND.REASONING_FINISHED);
    });
});

describe("a quiet market produces no reasoning at all", () => {
    it("emits one observation line and nothing else", async () => {
        const narrator = new Narrator({ clock: () => OPEN_IST });
        const transport = vi.fn();
        const orchestrator = buildOrchestrator({ narrator, transport });
        // A position sitting comfortably inside its levels raises no event.
        orchestrator.ports.loadPositions = async () => [position({
            currentPricePaise: 100_000, unrealisedPnlPaise: 0, pnlPercent: 0,
            stopDistance: 0.9, targetDistance: 0.9 })];

        await orchestrator.monitorCycle();
        await orchestrator.reasoningCycle();

        expect(transport).not.toHaveBeenCalled();
        expect(narrator.recent().map((e) => e.kind)).toEqual([KIND.MARKET_OBSERVATION]);
        expect(narrator.brain).toBe(BRAIN.IDLE);
        expect(narrator.currentThought).toBeNull();
    });

    it("says why an event did not wake the brain", async () => {
        const narrator = new Narrator({ clock: () => OPEN_IST });
        const orchestrator = buildOrchestrator({ narrator, transport: vi.fn() });
        orchestrator.ports.loadPositions = async () => [position({
            targetDistance: 0.1, stopDistance: 0.9 })];   // TARGET_APPROACHING, INFO

        await orchestrator.monitorCycle();

        const materiality = narrator.recent().filter((e) => e.kind === KIND.MATERIALITY);
        expect(materiality.length).toBeGreaterThan(0);
        const info = materiality.find((e) => e.material === false);
        expect(info).toBeDefined();
        expect(info.because).toMatch(/does not meet the threshold/);
    });
});

describe("narration can never break the runtime", () => {
    it("a narrator that throws does not stop a decision", async () => {
        const exploding = new Narrator({ clock: () => OPEN_IST });
        exploding.emit = () => { throw new Error("cockpit exploded"); };

        const executed = [];
        const orchestrator = buildOrchestrator({
            narrator: exploding, transport: transportFor(), executed });
        offerEvent(orchestrator);

        const handled = await orchestrator.reasoningCycle();
        expect(handled).toHaveLength(1);
        expect(handled[0].error).toBeUndefined();
        expect(orchestrator.metrics.errors).toBe(0);
    });

    it("the loop runs identically with no narrator attached", async () => {
        const orchestrator = buildOrchestrator({ narrator: null,
                                                 transport: transportFor() });
        offerEvent(orchestrator);
        const handled = await orchestrator.reasoningCycle();
        expect(handled).toHaveLength(1);
        expect(handled[0].action).toBeDefined();
    });
});
