// Evidence hierarchy.
//
// A senior trader does not confuse "price is above VWAP" with "buyers are
// aggressive". The first is arithmetic; the second is an interpretation that
// may be wrong. Conflating them is how a weak inference acquires the authority
// of a measurement.
//
// TIERS ARE ASSIGNED BY ORIGIN, NOT BY THE MODEL. Anything computed from data
// we hold is a FACT or OBSERVATION. Anything the LLM concludes is at best an
// INFERENCE. The model cannot promote its own reasoning to fact.

export const TIER = {
    FACT: "FACT",                 // measured or computed from data we hold
    OBSERVATION: "OBSERVATION",   // a measured comparison against a baseline
    INFERENCE: "INFERENCE",       // a conclusion drawn from facts
    HYPOTHESIS: "HYPOTHESIS",     // a candidate explanation, not established
    PREDICTION: "PREDICTION",     // a claim about the future
};

// Ordered strongest to weakest, for sorting and for refusing to let weak
// evidence outrank strong evidence in a summary.
export const TIER_RANK = {
    [TIER.FACT]: 0, [TIER.OBSERVATION]: 1, [TIER.INFERENCE]: 2,
    [TIER.HYPOTHESIS]: 3, [TIER.PREDICTION]: 4,
};

export const makeEvidence = ({ tier, statement, source, value = null }) => {
    if (!TIER[tier]) throw new Error(`unknown evidence tier: ${tier}`);
    if (!statement) throw new Error("evidence requires a statement");
    if (!source) throw new Error("evidence requires a source");
    return { tier, statement, source, value };
};

// Model-authored evidence is clamped: whatever the LLM claims a statement is,
// it can never be recorded above INFERENCE.
export const MODEL_MAX_TIER = TIER.INFERENCE;

export const clampModelTier = (tier) => {
    if (!TIER[tier]) return TIER.HYPOTHESIS;
    return TIER_RANK[tier] < TIER_RANK[MODEL_MAX_TIER] ? MODEL_MAX_TIER : tier;
};

export const fromModel = (statement, tier = TIER.INFERENCE) => makeEvidence({
    tier: clampModelTier(tier), statement, source: "llm",
});

export const sortByStrength = (evidence) =>
    [...evidence].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);

export const factsOnly = (evidence) =>
    evidence.filter((e) => e.tier === TIER.FACT || e.tier === TIER.OBSERVATION);

export const describeEvidence = (evidence) =>
    sortByStrength(evidence)
        .map((e) => `[${e.tier}] ${e.statement}` + (e.value !== null ? ` (${e.value})` : ""))
        .join("\n");
