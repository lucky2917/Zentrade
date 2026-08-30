import { callGroqSafe, MODELS } from "../aiEngine.js";
import { REASSESS_ACTIONS, CONFIDENCE_LEVELS } from "./reassess.js";
import { reason } from "../reasoning/pipeline.js";
import { makeStageNarrator } from "../cockpit/reasoningNarration.js";

// The autonomous reasoning adapters.
//
// These bind the senior-trader reasoning pipeline (TraderState -> form ->
// challenge -> deterministic synthesis) to the existing Groq transport and to
// the shapes the runtime already consumes. There is no second AI engine, and
// the runtime call sites are unchanged.
//
// Neither adapter can execute. The pipeline produces a decision, the
// deterministic risk gate authorises it, and only then does the single
// execution port run.

const FORMATION_MODEL = MODELS.synthesizer;
const CHALLENGE_MODEL = MODELS.risk;

// Formation is allowed a little exploration; the challenger is held near zero
// so that "this thesis is weak" is a stable judgement rather than a sample.
const FORMATION_TEMPERATURE = 0.3;
const CHALLENGE_TEMPERATURE = 0.1;
const MAX_TOKENS = 900;

// The transport is injectable so the reasoning path can be exercised end to
// end without a network call. Production always uses callGroqSafe.
const modelCaller = (transport, model, temperature, label, sink) => async (prompt) =>
    transport(model, prompt, temperature, MAX_TOKENS, sink, label);

// What gets written to the thesis record as supporting evidence: the
// deterministic TraderState evidence with its tiers, plus the statements the
// model actually relied on. Model runs go to the journal, not the thesis.
const evidenceRecord = (decision) => [
    ...(decision.state?.evidence ?? []),
    ...(decision.supportingEvidence ?? []).map((statement) => ({
        tier: "INFERENCE", source: "thesis formation", statement,
    })),
];

const narrate = (decision) => {
    const parts = [];
    if (decision.thesis) parts.push(decision.thesis);
    if (decision.reasons?.length) parts.push(`Deterministic checks: ${decision.reasons.join("; ")}.`);
    if (decision.confidenceReason?.length)
        parts.push(`Confidence ${decision.confidence}: ${decision.confidenceReason.join("; ")}.`);
    return parts.join(" ") || "no reasoning supplied";
};

const journal = (logger, event, decision, extra) => logger?.info?.("SeniorReasoning", event, {
    action: decision.action,
    confidence: decision.confidence,
    edge: decision.edge?.verdict,
    riskReward: decision.riskReward?.ratio,
    challenge: decision.challenge?.verdict,
    downgraded: decision.downgraded,
    ...extra,
});

// ---- candidate analysis ----------------------------------------------------

export const makeCandidateAnalyser = ({
    logger = null, formationModel = FORMATION_MODEL, challengeModel = CHALLENGE_MODEL,
    limits = {}, transport = callGroqSafe, narrator = null,
} = {}) =>
    async ({ symbol, context, event, reasons, correlationId, news, portfolio,
             dailyRegimeTag = null, riskState = null, market = null,
             memories = [], asOf = null }) => {
        const sink = [];
        let decision;
        try {
            decision = await reason({
                // Each stage is narrated as it completes, so the cockpit shows
                // the reasoning arriving in the order it happened.
                onStage: narrator ? makeStageNarrator({
                    narrator, symbol, route: "CANDIDATE", correlationId,
                    trigger: event?.type ?? "screen",
                }) : null,
                symbol, context, event, news: news ?? [], portfolio, market,
                dailyRegimeTag, riskState, screenReasons: reasons ?? [],
                memories,
                // The decision's instant, not the moment this line runs.
                asOf: asOf ?? context?.asOf, limits, logger,
                formModel: modelCaller(transport, formationModel, FORMATION_TEMPERATURE,
                                        "senior_thesis_formation", sink),
                challengeModel: modelCaller(transport, challengeModel, CHALLENGE_TEMPERATURE,
                                            "senior_thesis_challenge", sink),
            });
        } catch (err) {
            logger?.error?.("SeniorReasoning", "candidate reasoning failed",
                            { error: err.message, symbol });
            return { action: "HOLD", confidence: "LOW", fallback: true,
                     reasoning: `Safe fallback: reasoning failed (${err.message})`,
                     evidence: [], correlationId };
        }

        const action = ["BUY", "HOLD"].includes(decision.action) ? decision.action : "HOLD";
        const confidence = CONFIDENCE_LEVELS.includes(decision.confidence)
            ? decision.confidence : "LOW";
        const quantity = Number.isInteger(decision.quantity) && decision.quantity > 0
            ? decision.quantity : null;

        // A BUY with no usable size is not actionable. It degrades to HOLD
        // rather than the system inventing a position size.
        if (action === "BUY" && quantity === null) {
            journal(logger, "candidate downgraded: no size", decision, { symbol });
            return { action: "HOLD", confidence: "LOW", fallback: true,
                     reasoning: "Safe fallback: thesis proposed BUY without a usable quantity",
                     evidence: evidenceRecord(decision), correlationId };
        }

        journal(logger, "candidate", decision, { symbol, correlationId });

        return {
            action, confidence, quantity,
            reasoning: narrate(decision),
            setupType: decision.setup ?? "unclassified",
            invalidationConditions: decision.invalidationConditions?.length
                ? decision.invalidationConditions : null,
            stopPaise: decision.stopPaise ?? null,
            targetPaise: decision.targetPaise ?? null,
            horizon: decision.horizon ?? "INTRADAY",
            evidence: evidenceRecord(decision),

            confidenceReason: decision.confidenceReason,
            supportingEvidence: decision.supportingEvidence,
            contradictingEvidence: decision.contradictingEvidence,
            alternativeHypotheses: decision.alternativeHypotheses,
            whatWouldChangeMyMind: decision.whatWouldChangeMyMind,
            uncertainty: decision.uncertainty,
            marketRegime: decision.marketRegime,
            riskReward: decision.riskReward,
            edge: decision.edge,
            expectedValue: decision.expectedValue,
            opportunityCost: decision.opportunityCost,
            challenge: decision.challenge,
            downgraded: decision.downgraded,
            agentRuns: sink,
            correlationId,
            fallback: Boolean(decision.fallback),
        };
    };

// ---- position reassessment -------------------------------------------------

// The reassessment context is built by buildReassessmentContext. It is mapped
// back onto the pipeline's inputs here rather than the pipeline learning a
// second input shape.
export const positionFromContext = (context) => ({
    quantity: context.quantity,
    entryPricePaise: context.entryPricePaise,
    currentPricePaise: context.currentPricePaise,
    unrealisedPnlPaise: context.unrealisedPnlPaise,
    pnlPercent: context.pnlPercent,
    holdingSeconds: context.holdingSeconds,
    exposurePaise: Number.isFinite(context.currentPricePaise) && Number.isFinite(context.quantity)
        ? context.currentPricePaise * context.quantity : null,
    stopDistance: context.stopDistance,
    targetDistance: context.targetDistance,
    stale: context.dataStale,
});

export const thesisFromContext = (context) => ({
    rationale: context.originalThesis?.rationale,
    setup_type: context.originalThesis?.setupType,
    invalidation_conditions: context.originalThesis?.invalidationConditions,
    horizon: context.originalThesis?.horizon,
    stop_paise: context.originalThesis?.stopPaise,
    target_paise: context.originalThesis?.targetPaise,
});

// The `callModel` the runtime passes to reassessPosition. That function keeps
// its own timeout and guardrails; this returns the parsed decision for them to
// check. Two independent deterministic layers, on purpose.
export const makeReassessmentModel = ({
    logger = null, formationModel = FORMATION_MODEL, challengeModel = CHALLENGE_MODEL,
    limits = {}, transport = callGroqSafe, narrator = null,
} = {}) =>
    async (context) => {
        const sink = [];
        const decision = await reason({
            onStage: narrator ? makeStageNarrator({
                narrator, symbol: context.symbol, route: "POSITION",
                correlationId: context.correlationId ?? null,
                trigger: context.trigger?.type ?? "scheduled",
            }) : null,
            symbol: context.symbol,
            context: context.marketState,
            event: context.trigger,
            position: positionFromContext(context),
            thesis: thesisFromContext(context),
            previousAssessment: context.previousAssessment ?? null,
            portfolio: context.portfolio ?? null,
            market: context.market ?? null,
            news: context.news ?? [],
            memories: context.memories ?? [],
            asOf: context.asOf ?? context.marketState?.asOf,
            limits, logger,
            formModel: modelCaller(transport, formationModel, FORMATION_TEMPERATURE,
                                    "senior_reassess_formation", sink),
            challengeModel: modelCaller(transport, challengeModel, CHALLENGE_TEMPERATURE,
                                         "senior_reassess_challenge", sink),
        });

        // The pipeline could not form a view. reassessPosition owns the one
        // documented fallback for that, so surface it there rather than
        // returning a HOLD that reads like a judgement.
        if (decision.fallback) {
            throw new Error(decision.reasons?.[0] ?? "reasoning unavailable");
        }

        journal(logger, "reassessment", decision,
                { symbol: context.symbol, trigger: context.trigger?.type });

        return {
            action: REASSESS_ACTIONS.includes(decision.action) ? decision.action : "HOLD",
            confidence: decision.confidence,
            thesisStillValid: decision.thesisStillValid ?? true,
            whatChanged: decision.whatChanged ?? "unspecified",
            material: Boolean(decision.material),
            reasoning: narrate(decision),
            reassessmentCode: decision.reassessmentCode,
            confidenceReason: decision.confidenceReason,
            alternativeHypotheses: decision.alternativeHypotheses,
            whatWouldChangeMyMind: decision.whatWouldChangeMyMind,
            challenge: decision.challenge,
            riskReward: decision.riskReward,
            edge: decision.edge,
            thesisAge: decision.thesisAge,
            downgraded: decision.downgraded,
            agentRuns: sink,
            evidence: evidenceRecord(decision),
        };
    };

export { REASSESS_ACTIONS };
