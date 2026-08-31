import { KIND } from "./narrator.js";
import { TIER_RANK } from "../reasoning/evidence.js";

// Turning the reasoning pipeline's stages into cockpit narration.
//
// Everything shown here is a structured artifact the system already produces on
// purpose and already writes to the journal: the deterministic TraderState, the
// formed thesis, the challenge, the alternatives, the arithmetic. None of it is
// hidden chain-of-thought, and none of it is generated for display.
//
// The cost hurdle is the one number an operator most needs and most easily
// forgets: a decision that clears R:R but not costs is not an edge.
export const COST_HURDLE_BPS = 73.55;

const MAX_ITEMS = 6;

// These arrays do not hold strings.
//
// `supportingEvidence` holds evidence records ({tier, statement, source}) built
// by fromModel, and `alternativeHypotheses` holds ({explanation, supportedBy,
// plausibility}). String() on either produces "[object Object]", which is what
// the cockpit was rendering where the reasoning should have been.
export const readable = (item) => {
    if (item === null || item === undefined) return null;
    if (typeof item === "string") return item.trim() || null;
    if (typeof item !== "object") return String(item);

    // An evidence record: show the claim, and its tier, because the tier is
    // the part that says how much weight it carries.
    if (typeof item.statement === "string") {
        return item.tier ? `[${item.tier}] ${item.statement}` : item.statement;
    }
    // An alternative hypothesis: the explanation, with what supports it.
    if (typeof item.explanation === "string") {
        const support = typeof item.supportedBy === "string" && item.supportedBy
            ? ` — supported by ${item.supportedBy}` : "";
        const odds = item.plausibility ? ` (${item.plausibility})` : "";
        return `${item.explanation}${support}${odds}`;
    }
    if (typeof item.reason === "string") return item.reason;
    // Something with no readable field is reported as unreadable rather than
    // rendered as "[object Object]", which tells the operator nothing.
    return null;
};

export const list = (value) => {
    if (!value) return [];
    const items = Array.isArray(value) ? value : [value];
    return items.map(readable).filter(Boolean).slice(0, MAX_ITEMS);
};

// The strongest deterministic evidence, which is what an operator should read
// first. Sorted by tier so a FACT never appears below an INFERENCE.
export const topEvidence = (state, limit = 8) => (state?.evidence ?? [])
    .slice()
    .sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9))
    .slice(0, limit)
    .map((e) => ({ tier: e.tier, statement: e.statement, source: e.source,
                   value: e.value ?? null }));

// Confidence is never invented. If the pipeline could not justify one, the
// cockpit says so rather than showing a number that means nothing.
export const confidenceOf = (decision) => {
    if (!decision?.confidence) return { level: "UNKNOWN", basis: ["no confidence stated"] };
    const basis = list(decision.confidenceReason);
    if (!basis.length) return { level: decision.confidence, basis: ["INSUFFICIENT BASIS"] };
    return { level: decision.confidence, basis };
};

// One handler per reasoning run. Bound to a symbol and correlation id so the
// cockpit can group the stages of one decision together.
export const makeStageNarrator = ({ narrator, symbol, trigger = null,
                                    route = "POSITION", correlationId = null }) => {
    const base = { symbol, trigger, route, correlationId };

    return (stage, payload) => {
        switch (stage) {
            case "state": {
                const state = payload.state ?? {};
                narrator.emit(KIND.WHAT_I_KNOW, {
                    ...base,
                    evidence: topEvidence(state),
                    regime: state.market?.regime ?? "UNKNOWN",
                    sessionPhase: state.market?.sessionPhase ?? "UNKNOWN",
                    breadth: state.market?.breadth ?? "UNKNOWN",
                    dataStale: Boolean(state.market?.dataStale),
                    // Present only when holding: the entry thesis is immutable
                    // and must be visibly separate from what is believed now.
                    originalThesis: state.originalThesis ?? null,
                    previousAssessment: state.previousAssessment ?? null,
                    memory: state.memory ?? null,
                });
                break;
            }
            case "formed": {
                const formed = payload.formed ?? {};
                narrator.emit(KIND.THESIS_FORMED, {
                    ...base,
                    thesis: formed.thesis ?? null,
                    setup: formed.setup ?? null,
                    supportingEvidence: list(formed.supportingEvidence),
                    contradictingEvidence: list(formed.contradictingEvidence),
                    invalidationConditions: list(formed.invalidationConditions),
                    catalyst: formed.catalyst ?? null,
                    uncertainty: list(formed.uncertainty),
                    // validateThesis returns proposedAction; reading .action
                    // showed null in the cockpit for every thesis ever formed.
                    proposedAction: formed.proposedAction ?? null,
                    forcedHoldReason: formed.forcedHoldReason ?? null,
                    falsifiable: formed.falsifiable ?? null,
                    quantity: formed.quantity ?? null,
                    stopPaise: formed.stopPaise ?? null,
                    targetPaise: formed.targetPaise ?? null,
                });
                break;
            }
            case "challenged": {
                const { challenge = {}, challenged = {} } = payload;
                narrator.emit(KIND.THESIS_CHALLENGED, {
                    ...base,
                    verdict: challenge.verdict ?? "UNKNOWN",
                    strongestObjection: challenge.strongestObjection ?? null,
                    counterThesis: challenge.counterThesis ?? null,
                    downgraded: Boolean(challenged.downgraded),
                    reasons: list(challenged.reasons),
                });
                if (challenge.alternativeHypotheses?.length) {
                    narrator.emit(KIND.ALTERNATIVES, {
                        ...base, alternatives: list(challenge.alternativeHypotheses) });
                }
                if (challenge.whatWouldChangeTheDecision) {
                    narrator.emit(KIND.WHAT_WOULD_CHANGE_MY_MIND, {
                        ...base, conditions: list(challenge.whatWouldChangeTheDecision) });
                }
                break;
            }
            case "synthesis": {
                const s = payload.synthesis ?? {};
                narrator.emit(KIND.SYNTHESIS, {
                    ...base,
                    action: s.action ?? null,
                    riskReward: s.riskReward ?? null,
                    edge: s.edge ?? null,
                    expectedValue: s.expectedValue ?? null,
                    opportunityCost: s.opportunityCost ?? null,
                    thesisAge: s.thesisAge ?? null,
                    costHurdleBps: COST_HURDLE_BPS,
                    reasons: list(s.reasons),
                    downgraded: Boolean(s.downgraded),
                });
                break;
            }
            default:
                break;
        }
    };
};

// The decision itself, emitted by the caller once the pipeline returns.
export const narrateDecision = ({ narrator, symbol, trigger, route, correlationId,
                                  decision }) => {
    const confidence = confidenceOf(decision);
    return narrator.emit(KIND.DECISION, {
        symbol, trigger, route, correlationId,
        action: decision?.action ?? "HOLD",
        confidence: confidence.level,
        confidenceBasis: confidence.basis,
        thesisStillValid: decision?.thesisStillValid ?? null,
        whatChanged: decision?.whatChanged ?? null,
        quantity: decision?.quantity ?? null,
        reasons: list(decision?.reasons),
        fallback: Boolean(decision?.fallback),
        downgraded: Boolean(decision?.downgraded),
    });
};

// The permanent record of a decision that reached an order.
export const decisionCard = ({ symbol, action, decision, risk, intent, order }) => ({
    symbol,
    action,
    quantity: intent?.quantity ?? decision?.quantity ?? null,
    trigger: decision?.reasoningTrigger ?? null,
    thesis: decision?.thesis ?? null,
    counterThesis: decision?.challenge?.counterThesis ?? null,
    supportingEvidence: list(decision?.supportingEvidence),
    contradictingEvidence: list(decision?.contradictingEvidence),
    alternatives: list(decision?.alternativeHypotheses),
    whatWouldChangeMyMind: list(decision?.whatWouldChangeMyMind),
    riskReward: decision?.riskReward ?? null,
    edge: decision?.edge ?? null,
    expectedValue: decision?.expectedValue ?? null,
    opportunityCost: decision?.opportunityCost ?? null,
    costHurdleBps: COST_HURDLE_BPS,
    confidence: confidenceOf(decision).level,
    riskDecision: risk?.decision ?? null,
    riskCode: risk?.code ?? null,
    riskReason: risk?.reason ?? null,
    pricePaise: intent?.pricePaise ?? null,
    orderId: order?.orderId ?? order?.id ?? null,
    orderState: order?.state ?? null,
});
