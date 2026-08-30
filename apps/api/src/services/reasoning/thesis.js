import { describeEvidence, fromModel, TIER } from "./evidence.js";

// Thesis formation and adversarial challenge.
//
// Two separate calls, deliberately. The same reasoning process cannot both
// author a view and honestly attack it: asked to check its own work, a model
// agrees with itself. The challenger is given the thesis and told its job is to
// break it.
//
// Bounded: exactly two calls per material event. Never per tick.

export const REASSESSMENT_CODES = [
    "NEW_INFORMATION", "PRICE_ACTION_CHANGE", "VWAP_CHANGE", "MTF_CHANGE",
    "VOLATILITY_CHANGE", "VOLUME_CHANGE", "NEWS", "MARKET_REGIME_CHANGE",
    "THESIS_INVALIDATION", "RISK_CHANGE", "TIME_DECAY", "POSITION_LOSS", "POSITION_GAIN",
];

const stateBlock = (s) => `
AS OF: ${s.asOf}
SYMBOL: ${s.symbol}

${s.screenReasons?.length ? `WHY THIS SYMBOL SURFACED\n  ${s.screenReasons.join("; ")}\n` : ""}
MARKET
  session phase: ${s.market.sessionPhase} (${s.market.minutesIntoSession} min in)
  regime: ${s.market.regime} (basis: ${s.market.regimeBasis})
  data stale: ${s.market.dataStale}

EVIDENCE (tier assigned by origin, not by you)
${describeEvidence(s.evidence)}

${s.news.length ? `NEWS\n${s.news.map((n) =>
    `  [${n.materiality}] ${n.category}: ${n.subject} (${n.disseminatedAt})`).join("\n")}`
    : "NEWS\n  none retrieved in this window. This is NOT evidence that nothing happened."}
`;

const positionBlock = (s) => !s.position ? "" : `
POSITION HELD
  quantity ${s.position.quantity}, entry Rs ${(s.position.entryPricePaise / 100).toFixed(2)}
  current Rs ${(s.position.currentPricePaise / 100).toFixed(2)}, P&L ${s.position.pnlPercent?.toFixed(2)}%
  held ${Math.round((s.position.holdingSeconds ?? 0) / 60)} minutes
  distance to stop ${s.position.stopDistance?.toFixed(2)}, to target ${s.position.targetDistance?.toFixed(2)}

ORIGINAL THESIS (recorded at entry, immutable)
  ${s.originalThesis?.rationale ?? "none recorded"}
  setup: ${s.originalThesis?.setupType ?? "unknown"}
  invalidation: ${JSON.stringify(s.originalThesis?.invalidationConditions ?? [])}
  horizon: ${s.originalThesis?.horizon ?? "unknown"}

${s.previousAssessment ? `PREVIOUS BELIEF (last reassessment)
  action ${s.previousAssessment.action}, thesis still valid: ${s.previousAssessment.thesisStillValid}
  what changed then: ${s.previousAssessment.whatChanged}`
    : "PREVIOUS BELIEF\n  none; this is the first reassessment."}
`;

// ---- formation -------------------------------------------------------------

export const buildFormationPrompt = (state) => `
You are a disciplined senior trader forming a view on an Indian equity.

${stateBlock(state)}
${positionBlock(state)}
${state.trigger ? `WHAT PROMPTED THIS REVIEW\n  ${state.trigger.type} (${state.trigger.severity}): ${state.trigger.reason}` : ""}

${state.position
    ? "You ALREADY HOLD this position. Do not ask whether you would buy it today. Ask whether the ORIGINAL thesis is still valid given what has changed."
    : "You do not hold this. Ask whether there is enough evidence to establish a position."}

Rules:
- Distinguish what is measured from what you are inferring. Do not state an
  inference as a fact.
- If evidence is thin, incomplete or conflicting, say so. NO TRADE is a
  legitimate and often correct conclusion.
- Do not invent probabilities, prices, volumes or news you were not given.
- If you cannot name what would prove you wrong, you do not have a thesis.

Respond with JSON only:
{
  "thesis": "<one paragraph: what you think is happening and why>",
  "setup": "<short label>",
  "direction": "LONG" | "SHORT" | "NONE",
  "supportingEvidence": ["<statements drawn from the evidence above>"],
  "contradictingEvidence": ["<what argues against this view>"],
  "invalidationConditions": ["<specific, observable, would prove this wrong>"],
  "catalyst": "<what would make this resolve, or 'none identified'>",
  "timeHorizon": "INTRADAY" | "SWING" | "POSITIONAL",
  "uncertainty": ["<what you do not know that matters>"],
  "proposedAction": ${state.position ? '"HOLD" | "REDUCE" | "EXIT" | "ADD"' : '"BUY" | "HOLD"'},
  "stopRupees": <number or null>,
  "targetRupees": <number or null>,
  "quantity": <integer or null>
}`;

// ---- challenge -------------------------------------------------------------

export const buildChallengePrompt = (state, thesis) => `
You are a senior risk-minded trader whose job is to BREAK the following thesis.
You are not being asked to be balanced. You are being asked to find what is
wrong with it.

${stateBlock(state)}
${positionBlock(state)}

THE THESIS UNDER EXAMINATION
  ${thesis.thesis}
  proposed action: ${thesis.proposedAction}
  claimed support: ${JSON.stringify(thesis.supportingEvidence ?? [])}

Your tasks:
1. State the strongest argument AGAINST this thesis.
2. State the COUNTER-THESIS: not merely an objection, but the competing
   explanation you would trade instead, stated as a position.
3. Give alternative explanations for the same observations. Consider at least:
   genuine move, short covering, market-wide drift, news-driven spike,
   thin-liquidity distortion, mean reversion after an overextension.
4. Name what information is MISSING that would matter.
5. Say whether this could be a false signal, and how you would tell.
6. Say what evidence would change the decision.
7. Judge whether the author was only looking for confirming evidence.

Do not soften your assessment to be agreeable. If the thesis is weak, say it is
weak. If it is sound, say that plainly too.

Respond with JSON only:
{
  "strongestObjection": "<the single best argument against>",
  "counterThesis": "<the competing view you would trade instead, as a position>",
  "alternativeHypotheses": [
    {"explanation": "<...>", "supportedBy": "<evidence or 'nothing observed'>", "plausibility": "HIGH"|"MEDIUM"|"LOW"}
  ],
  "missingInformation": ["<...>"],
  "couldBeFalseSignal": true | false,
  "falseSignalTell": "<how you would know>",
  "whatWouldChangeTheDecision": ["<...>"],
  "confirmationBiasDetected": true | false,
  "verdict": "THESIS_HOLDS" | "THESIS_WEAK" | "THESIS_BROKEN"
}`;

// ---- deterministic validation of both outputs ------------------------------

const asArray = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []);

export const validateThesis = (raw, state) => {
    if (!raw || typeof raw !== "object") return null;

    const actions = state.position
        ? ["HOLD", "REDUCE", "EXIT", "ADD"] : ["BUY", "HOLD"];
    const proposedAction = actions.includes(raw.proposedAction) ? raw.proposedAction : "HOLD";

    const invalidation = asArray(raw.invalidationConditions);
    // A thesis that cannot be falsified is not a thesis. Rather than accepting
    // it, the action is forced to HOLD.
    const falsifiable = invalidation.length > 0;

    return {
        thesis: typeof raw.thesis === "string" && raw.thesis.trim()
            ? raw.thesis.trim() : "no thesis articulated",
        setup: typeof raw.setup === "string" ? raw.setup : "unclassified",
        direction: ["LONG", "SHORT", "NONE"].includes(raw.direction) ? raw.direction : "NONE",
        supportingEvidence: asArray(raw.supportingEvidence).map((s) => fromModel(s, TIER.INFERENCE)),
        contradictingEvidence: asArray(raw.contradictingEvidence).map((s) => fromModel(s, TIER.INFERENCE)),
        invalidationConditions: invalidation,
        falsifiable,
        catalyst: typeof raw.catalyst === "string" ? raw.catalyst : "none identified",
        timeHorizon: ["INTRADAY", "SWING", "POSITIONAL"].includes(raw.timeHorizon)
            ? raw.timeHorizon : "INTRADAY",
        uncertainty: asArray(raw.uncertainty),
        proposedAction: falsifiable ? proposedAction : "HOLD",
        forcedHoldReason: falsifiable ? null : "no invalidation condition supplied; not a falsifiable thesis",
        stopPaise: Number.isFinite(raw.stopRupees) ? Math.round(raw.stopRupees * 100) : null,
        targetPaise: Number.isFinite(raw.targetRupees) ? Math.round(raw.targetRupees * 100) : null,
        quantity: Number.isInteger(raw.quantity) && raw.quantity > 0 ? raw.quantity : null,
        probability: null,   // never taken from the model
    };
};

export const validateChallenge = (raw) => {
    if (!raw || typeof raw !== "object") {
        // A challenge that cannot be parsed is treated as the most adverse
        // outcome, not as an absence of objection.
        return {
            strongestObjection: "challenge unavailable",
            counterThesis: "not established; the challenge could not be read",
            alternativeHypotheses: [], missingInformation: [],
            couldBeFalseSignal: true, falseSignalTell: "unknown",
            whatWouldChangeTheDecision: [], confirmationBiasDetected: false,
            verdict: "THESIS_WEAK", unavailable: true,
        };
    }
    const alternatives = Array.isArray(raw.alternativeHypotheses)
        ? raw.alternativeHypotheses
            .filter((a) => a && typeof a.explanation === "string")
            .slice(0, 6)
            .map((a) => ({
                explanation: a.explanation,
                supportedBy: typeof a.supportedBy === "string" ? a.supportedBy : "nothing observed",
                plausibility: ["HIGH", "MEDIUM", "LOW"].includes(a.plausibility) ? a.plausibility : "LOW",
            }))
        : [];

    return {
        strongestObjection: typeof raw.strongestObjection === "string"
            ? raw.strongestObjection : "none articulated",
        // The competing view, stated as a position rather than an objection.
        // Absent is reported as absent: a counter-thesis nobody articulated
        // must not read as a counter-thesis that does not exist.
        counterThesis: typeof raw.counterThesis === "string" && raw.counterThesis.trim()
            ? raw.counterThesis.trim() : "none articulated",
        alternativeHypotheses: alternatives,
        missingInformation: asArray(raw.missingInformation),
        couldBeFalseSignal: raw.couldBeFalseSignal === true,
        falseSignalTell: typeof raw.falseSignalTell === "string" ? raw.falseSignalTell : "unknown",
        whatWouldChangeTheDecision: asArray(raw.whatWouldChangeTheDecision),
        confirmationBiasDetected: raw.confirmationBiasDetected === true,
        verdict: ["THESIS_HOLDS", "THESIS_WEAK", "THESIS_BROKEN"].includes(raw.verdict)
            ? raw.verdict : "THESIS_WEAK",
        unavailable: false,
    };
};

// The challenge can only ever make the decision more conservative.
export const applyChallenge = (thesis, challenge) => {
    const reasons = [];
    let action = thesis.proposedAction;

    if (challenge.verdict === "THESIS_BROKEN") {
        if (["BUY", "ADD"].includes(action)) { action = "HOLD"; reasons.push("challenger judged the thesis broken"); }
        // For a held position a broken thesis is a reason to leave, not to sit.
        if (action === "HOLD" && thesis.isPosition) { action = "EXIT"; reasons.push("held position with a broken thesis"); }
    }
    if (challenge.verdict === "THESIS_WEAK" && ["BUY", "ADD"].includes(action)) {
        action = "HOLD";
        reasons.push("challenger judged the thesis weak; no new exposure on a weak thesis");
    }
    if (challenge.couldBeFalseSignal && ["BUY", "ADD"].includes(action)) {
        action = "HOLD";
        reasons.push(`possible false signal: ${challenge.falseSignalTell}`);
    }
    if (challenge.confirmationBiasDetected && ["BUY", "ADD"].includes(action)) {
        action = "HOLD";
        reasons.push("confirmation bias detected in the supporting argument");
    }

    return { action, downgraded: action !== thesis.proposedAction, reasons };
};
