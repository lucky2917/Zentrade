// Position-aware reasoning.
//
// This is deliberately NOT analyseStock. Asking the discovery prompt about a
// position you already hold produces a fresh opinion, not a reassessment: it
// has no entry price, no original thesis, and no notion of what changed. The
// question here is "is what we believed at entry still true?", which needs
// different inputs and yields a different action vocabulary.
//
// The LLM is injected so this path is testable without a network call, and so
// a malformed or absent model response has an explicit, tested behaviour.

export const REASSESS_ACTIONS = ["HOLD", "REDUCE", "EXIT", "ADD"];
export const CONFIDENCE_LEVELS = ["HIGH", "MEDIUM", "LOW"];

// The safe state. When the model is unavailable, slow, or incoherent, the
// system keeps what it has and records why. It does not invent certainty, and
// it never escalates to a new action on missing information.
export const safeFallback = (reason) => ({
    action: "HOLD",
    confidence: "LOW",
    thesisStillValid: true,
    whatChanged: "unknown",
    material: false,
    reasoning: `Safe fallback: ${reason}`,
    evidence: [],
    fallback: true,
});

export const buildReassessmentContext = ({
    position, thesis, event, marketState, portfolio, news = [], market = null,
    memories = [],
}) => ({
    symbol: position.symbol,
    side: thesis.side,
    entryPricePaise: Number(thesis.entry_price_paise),
    currentPricePaise: position.currentPricePaise,
    unrealisedPnlPaise: position.unrealisedPnlPaise,
    pnlPercent: position.pnlPercent,
    quantity: position.quantity,
    holdingSeconds: position.holdingSeconds,
    sessionPhase: position.sessionPhase,

    originalThesis: {
        rationale: thesis.rationale,
        setupType: thesis.setup_type,
        invalidationConditions: thesis.invalidation_conditions,
        supportingEvidence: thesis.supporting_evidence,
        horizon: thesis.horizon,
        stopPaise: thesis.stop_paise === null ? null : Number(thesis.stop_paise),
        targetPaise: thesis.target_paise === null ? null : Number(thesis.target_paise),
    },

    trigger: event ? {
        type: event.type ?? event.event_type,
        severity: event.severity,
        reason: event.reason,
        observed: event.observed,
    } : null,

    stopDistance: position.stopDistance,
    targetDistance: position.targetDistance,
    marketRegime: marketState?.regime ?? null,
    portfolioDrawdownPercent: portfolio?.drawdownPercent ?? null,
    dataStale: position.stale,
    marketState: marketState ?? null,
    market,
    news,
    memories,
});

// Deterministic guardrails on the model's answer, mirroring the discovery
// path's: an illegal action becomes the safe state rather than being guessed
// at, and an unusable confidence falls back rather than being invented.
export const applyReassessmentGuardrails = (raw, context) => {
    if (!raw || typeof raw !== "object") return safeFallback("model returned no object");

    const result = { ...raw };

    if (!REASSESS_ACTIONS.includes(result.action)) {
        return safeFallback(`model returned illegal action ${JSON.stringify(raw.action)}`);
    }
    if (!CONFIDENCE_LEVELS.includes(result.confidence)) result.confidence = "LOW";
    if (typeof result.thesisStillValid !== "boolean") result.thesisStillValid = true;
    if (typeof result.material !== "boolean") result.material = false;
    if (typeof result.whatChanged !== "string" || !result.whatChanged.trim())
        result.whatChanged = "unspecified";
    if (typeof result.reasoning !== "string" || !result.reasoning.trim())
        result.reasoning = "no reasoning supplied";
    if (!Array.isArray(result.evidence)) result.evidence = [];

    // Stale data cannot justify adding exposure. Exiting stays permitted,
    // because being unable to leave is the worse failure.
    if (context?.dataStale && result.action === "ADD") {
        return { ...result, action: "HOLD", confidence: "LOW",
                 reasoning: `${result.reasoning} [guardrail: ADD blocked on stale data]` };
    }

    // A model that says the thesis is broken but proposes to add to the
    // position is incoherent. Fall back rather than act on the contradiction.
    if (result.thesisStillValid === false && result.action === "ADD") {
        return safeFallback("model proposed ADD while declaring the thesis invalid");
    }

    result.fallback = false;
    return result;
};

export const reassessPosition = async ({
    position, thesis, event, marketState, portfolio, callModel, news = [],
    memories = [],
    market = null, timeoutMs = 15_000,
}) => {
    const context = buildReassessmentContext({
        position, thesis, event, marketState, portfolio, news, market, memories });

    if (!callModel) return { ...safeFallback("no model configured"), context };

    let raw;
    try {
        raw = await Promise.race([
            callModel(context),
            new Promise((_, rejectPromise) =>
                setTimeout(() => rejectPromise(new Error("model timeout")), timeoutMs)),
        ]);
    } catch (err) {
        return { ...safeFallback(`model call failed: ${err.message}`), context };
    }

    return { ...applyReassessmentGuardrails(raw, context), context };
};
