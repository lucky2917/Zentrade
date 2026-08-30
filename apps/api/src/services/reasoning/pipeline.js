import { buildTraderState } from "./traderState.js";
import {
    buildFormationPrompt, buildChallengePrompt, validateThesis, validateChallenge,
    applyChallenge, REASSESSMENT_CODES,
} from "./thesis.js";
import { synthesise } from "./synthesis.js";
import { describeEvidence } from "./evidence.js";

// The senior-trader reasoning pipeline.
//
//   TraderState -> FORM -> CHALLENGE -> SYNTHESISE -> decision
//
// Exactly two LLM calls per material event. Every downgrade is deterministic
// and recorded, so "why did it not trade?" is always answerable.
//
// This produces a DECISION. It does not execute, size against limits, or
// override risk: the existing hard risk gate remains authoritative downstream.

export const LEGAL_CANDIDATE_ACTIONS = ["BUY", "HOLD"];
export const LEGAL_POSITION_ACTIONS = ["HOLD", "REDUCE", "EXIT", "ADD"];

export const safeDecision = (reason, state) => ({
    action: "HOLD",
    confidence: "LOW",
    confidenceReason: [reason],
    thesis: null,
    challenge: null,
    synthesis: null,
    reasoningTrigger: state?.trigger?.type ?? "scheduled",
    fallback: true,
    reasons: [reason],
    whatWouldChangeMyMind: [],
});

// Which bounded reason code describes why we are reasoning at all.
export const reassessmentCodeFor = (state) => {
    const type = state?.trigger?.type;
    const map = {
        PRICE_JUMP: "PRICE_ACTION_CHANGE",
        VOLUME_SPIKE: "VOLUME_CHANGE",
        VOLATILITY_EXPANSION: "VOLATILITY_CHANGE",
        TECHNICAL_BREAKDOWN: "VWAP_CHANGE",
        STOP_BREACH: "THESIS_INVALIDATION",
        STOP_APPROACHING: "POSITION_LOSS",
        TARGET_BREACH: "POSITION_GAIN",
        TARGET_APPROACHING: "POSITION_GAIN",
        NEWS_EVENT: "NEWS",
        REGIME_CHANGE: "MARKET_REGIME_CHANGE",
        PORTFOLIO_DRAWDOWN: "RISK_CHANGE",
        THESIS_INVALIDATED: "THESIS_INVALIDATION",
    };
    const code = map[type] ?? "NEW_INFORMATION";
    return REASSESSMENT_CODES.includes(code) ? code : "NEW_INFORMATION";
};

// Confidence must be explainable. It is derived from the evidence balance and
// the challenger's verdict, never taken as a bare token from the model.
export const deriveConfidence = ({ thesis, challenge, synthesis }) => {
    const support = thesis?.supportingEvidence?.length ?? 0;
    const against = thesis?.contradictingEvidence?.length ?? 0;
    const unknowns = thesis?.uncertainty?.length ?? 0;
    const reasons = [];

    let level = "MEDIUM";
    if (challenge?.verdict === "THESIS_HOLDS" && support > against && unknowns === 0) {
        level = "HIGH";
        reasons.push(`${support} supporting vs ${against} contradicting, challenger found no break`);
    } else if (challenge?.verdict === "THESIS_BROKEN" || against >= support) {
        level = "LOW";
        reasons.push(against >= support
            ? `contradicting evidence (${against}) is not outweighed by support (${support})`
            : "challenger judged the thesis broken");
    } else {
        reasons.push(`${support} supporting, ${against} contradicting, ${unknowns} stated unknown(s)`);
    }

    if (unknowns > 0) reasons.push(`open questions: ${thesis.uncertainty.join("; ")}`);
    if (synthesis?.edge?.verdict === "INSUFFICIENT_BASIS") {
        reasons.push("expected move not quantifiable, so edge is unproven");
        level = "LOW";
    }
    if (challenge?.unavailable) {
        reasons.push("challenge unavailable; treated as adverse");
        level = "LOW";
    }
    return { level, reasons };
};

const callWithTimeout = async (fn, timeoutMs, label) => Promise.race([
    fn(),
    new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs)),
]);

export const reason = async ({
    symbol, context, event = null, position = null, thesis: entryThesis = null,
    portfolio = null, news = [], dailyRegimeTag = null, riskState = null,
    previousAssessment = null, screenReasons = [], market = null, asOf,
    formModel, challengeModel, limits = {}, timeoutMs = 20_000, logger = null,
}) => {
    const state = buildTraderState({
        symbol, context, event, position, thesis: entryThesis, portfolio, news,
        dailyRegimeTag, riskState, previousAssessment, screenReasons, market, asOf,
    });

    if (!formModel) return { ...safeDecision("no reasoning model configured", state), state };

    // --- 1. form -----------------------------------------------------------
    let formed;
    try {
        const raw = await callWithTimeout(
            () => formModel(buildFormationPrompt(state)), timeoutMs, "thesis formation");
        formed = validateThesis(raw, state);
    } catch (err) {
        return { ...safeDecision(`thesis formation failed: ${err.message}`, state), state };
    }
    if (!formed) return { ...safeDecision("thesis formation returned no usable object", state), state };
    formed.isPosition = Boolean(position);

    // --- 2. challenge ------------------------------------------------------
    let challenge;
    try {
        const raw = await callWithTimeout(
            () => challengeModel(buildChallengePrompt(state, formed)), timeoutMs, "thesis challenge");
        challenge = validateChallenge(raw);
    } catch (err) {
        logger?.error?.("Reasoning", "challenge failed", { error: err.message, symbol });
        challenge = validateChallenge(null);   // adverse by default
    }

    const challenged = applyChallenge(formed, challenge);

    // --- 3. deterministic synthesis ---------------------------------------
    const synthesis = synthesise({
        proposal: {
            action: challenged.action,
            supportingEvidence: formed.supportingEvidence,
            contradictingEvidence: formed.contradictingEvidence,
            stopPaise: formed.stopPaise, targetPaise: formed.targetPaise,
            quantity: formed.quantity, probability: null,
        },
        traderState: state, limits,
    });

    const legal = position ? LEGAL_POSITION_ACTIONS : LEGAL_CANDIDATE_ACTIONS;
    const action = legal.includes(synthesis.action) ? synthesis.action : "HOLD";

    const confidence = deriveConfidence({ thesis: formed, challenge, synthesis });

    const reasons = [
        ...(formed.forcedHoldReason ? [formed.forcedHoldReason] : []),
        ...challenged.reasons,
        ...synthesis.reasons,
    ];

    return {
        action,
        confidence: confidence.level,
        confidenceReason: confidence.reasons,

        // What is believed now, and why.
        thesis: formed.thesis,
        setup: formed.setup,
        marketRegime: state.market.regime,
        supportingEvidence: formed.supportingEvidence,
        contradictingEvidence: formed.contradictingEvidence,
        alternativeHypotheses: challenge.alternativeHypotheses,
        invalidationConditions: formed.invalidationConditions,
        catalyst: formed.catalyst,
        timeHorizon: formed.timeHorizon,
        horizon: formed.timeHorizon,
        uncertainty: formed.uncertainty,
        whatWouldChangeMyMind: challenge.whatWouldChangeTheDecision,

        // The adversarial pass, kept for the journal.
        challenge,

        // The arithmetic, never fabricated.
        riskReward: synthesis.riskReward,
        edge: synthesis.edge,
        expectedValue: synthesis.expectedValue,
        opportunityCost: synthesis.opportunityCost,
        thesisAge: synthesis.thesisAge,

        // Position-management fields, meaningful only when holding.
        thesisStillValid: position
            ? challenge.verdict !== "THESIS_BROKEN" && action !== "EXIT" : null,
        whatChanged: position
            ? (formed.uncertainty[0] ?? challenge.strongestObjection ?? "no material change stated")
            : null,
        material: position ? action !== "HOLD" : null,

        reasoningTrigger: state.trigger?.type ?? "scheduled",
        reassessmentCode: reassessmentCodeFor(state),
        quantity: formed.quantity,
        stopPaise: formed.stopPaise,
        targetPaise: formed.targetPaise,

        reasons,
        downgraded: challenged.downgraded || synthesis.downgraded,
        fallback: false,
        evidenceSnapshot: describeEvidence(state.evidence),
        state,
    };
};
