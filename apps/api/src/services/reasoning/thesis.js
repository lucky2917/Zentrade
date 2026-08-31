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

const stateBlock = (s, { withCapital = true } = {}) => `
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
${withCapital ? capitalBlock(s) : ""}`;

// What the account can actually deploy.
//
// This was missing, and its absence made an entry impossible rather than
// unlikely: asked for a quantity with no idea how much capital existed, the
// model correctly answered null every time, and a BUY with no usable size is
// degraded to HOLD by design. Every candidate died there, so the system could
// reason perfectly and never trade.
//
// Supplying it does NOT move risk to the model. It proposes a size; the
// deterministic risk gate still decides whether that size is permitted, and
// revalidation still re-checks it against the world at execution time.
const capitalBlock = (s) => {
    const rupees = (paise) => (Number.isFinite(paise)
        ? `Rs ${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`
        : "unknown");
    if (s.risk.cashPaise === null || s.risk.cashPaise === undefined) {
        return `\nACCOUNT\n  available capital unknown — do not propose a quantity`;
    }
    return `
ACCOUNT
  available capital: ${rupees(s.risk.cashPaise)}
  open positions: ${s.risk.positionCount ?? "unknown"}
  gross exposure: ${rupees(s.risk.grossExposurePaise)}
  unrealised P&L: ${rupees(s.risk.unrealisedPnlPaise)}

  Size any proposal against the available capital. A risk gate will
  independently re-check whatever you propose, so propose the size the thesis
  actually justifies rather than the largest one that would fit.`;
};

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
- Declining every setup is also a failure. A trader who never finds sufficient
  evidence is not being disciplined, they are not doing the job. Where the
  measured evidence does converge — multi-timeframe alignment, volume expansion
  against its own baseline, position relative to VWAP — that is a basis for a
  position, and saying so is the point of the exercise.
- Do not invent probabilities, prices, volumes or news you were not given.
- If you cannot name what would prove you wrong, you do not have a thesis.

If you propose BUY it must carry stopRupees, targetRupees and quantity, sized
against the available capital above. A BUY without all three is not actionable
and will be treated as HOLD, so either supply them or say HOLD and say why.
Your proposal is not the final word: an independent challenger will try to
break it, deterministic arithmetic will test it against a ${"73.55"} bps round-trip
cost hurdle, and a risk gate decides whether anything executes.

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

${stateBlock(state, { withCapital: false })}
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

VERDICT — these are not interchangeable, and finding an objection is not by
itself a verdict. You are expected to find objections; that is the job. What
the verdict records is how much the objections actually damage the thesis.

  THESIS_BROKEN  the evidence CONTRADICTS the thesis, or its stated
                 invalidation condition has already occurred. Not "I found
                 something to criticise" — the case is affirmatively wrong.
  THESIS_WEAK    the evidence is genuinely thin or conflicting. This one
                 PREVENTS ANY NEW POSITION, so it is a real judgement about
                 the evidence, not a hedge between the other two.
  THESIS_HOLDS   objections exist, as they always do for every trade, and the
                 measured evidence still supports the position. This is the
                 correct verdict when the named evidence converges — for
                 example multi-timeframe alignment with volume expansion
                 against its own baseline and price on the right side of VWAP
                 — even though a more perfect setup could always be imagined.

A challenger that returns the same verdict every time has told the reader
nothing. Discriminate.

CONTEXT you must not mistake for a flaw:

- This is INTRADAY trading in Indian equities. A 0.3% to 1.5% move IS the
  opportunity being traded. "The move is small in percentage terms" is not an
  objection here, and is never grounds for THESIS_BROKEN.
- Whether the expected move clears transaction costs is computed separately by
  deterministic arithmetic against a measured 73.55 bps round-trip hurdle. That
  check already exists and is not yours to duplicate or pre-empt.
- Position sizing and portfolio risk are enforced by a deterministic risk gate
  after you. Do not reject a thesis on sizing.
- Absence of a named catalyst is normal for a technical intraday setup and is
  not by itself disqualifying.

Judge the thesis on whether the evidence supports it, not on whether a more
perfect setup could be imagined. Do not soften your assessment to be agreeable:
if it is genuinely broken, say so plainly.

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

// Levels have to point the way the trade does.
//
// Observed live: a BUY proposed with a stop of Rs 1915 ABOVE a target of
// Rs 1850. Downstream, risk/reward is computed with absolute values, so that
// inversion produced a healthy-looking 3.36 and passed the cost hurdle. A
// nonsensical proposal must not survive arithmetic; the levels are dropped,
// which makes the action unactionable rather than silently wrong.
export const coherentLevels = ({ stopPaise, targetPaise, entryPaise, action }) => {
    const buying = action === "BUY" || action === "ADD";
    if (!buying || !Number.isFinite(entryPaise)) return { stopPaise, targetPaise };

    const stopBelowEntry = !Number.isFinite(stopPaise) || stopPaise < entryPaise;
    const targetAboveEntry = !Number.isFinite(targetPaise) || targetPaise > entryPaise;
    const orderedCorrectly = !Number.isFinite(stopPaise) || !Number.isFinite(targetPaise)
        || stopPaise < targetPaise;

    if (stopBelowEntry && targetAboveEntry && orderedCorrectly) {
        return { stopPaise, targetPaise };
    }
    return {
        stopPaise: null, targetPaise: null,
        incoherentLevels: `a long with stop ${stopPaise} and target ${targetPaise} `
            + `around an entry of ${entryPaise} is not a long`,
    };
};

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
        ...coherentLevels({
            stopPaise: Number.isFinite(raw.stopRupees) ? Math.round(raw.stopRupees * 100) : null,
            targetPaise: Number.isFinite(raw.targetRupees) ? Math.round(raw.targetRupees * 100) : null,
            entryPaise: state.symbolState?.price !== null && state.symbolState?.price !== undefined
                ? Math.round(state.symbolState.price * 100) : null,
            action: proposedAction,
        }),
        quantity: Number.isInteger(raw.quantity) && raw.quantity > 0 ? raw.quantity : null,
        probability: null,   // never taken from the model
    };
};

const VERDICTS = ["THESIS_HOLDS", "THESIS_WEAK", "THESIS_BROKEN"];

// Case and whitespace must not decide a trade. An unreadable verdict still
// falls back to the adverse one, but it is recorded as assumed rather than
// judged.
const normaliseVerdict = (value, raw = false) => {
    const cleaned = typeof value === "string"
        ? value.trim().toUpperCase().replace(/[\s-]+/g, "_") : "";
    const matched = VERDICTS.includes(cleaned) ? cleaned : null;
    return raw ? matched : (matched ?? "THESIS_WEAK");
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
        verdict: normaliseVerdict(raw.verdict),
        // True when the model's verdict could not be read and the adverse
        // default was applied. Without this the difference between "judged
        // weak" and "unparseable" was invisible, and both blocked every entry.
        verdictAssumed: normaliseVerdict(raw.verdict, true) === null,
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
    // THESIS_WEAK is reported, not applied here.
    //
    // It used to veto outright, and across every setup observed live the
    // challenger returned WEAK every single time — a verdict given 18 times out
    // of 18 is not a judgement, it is a reflex. Asking a model to BREAK a
    // thesis and then treating its self-assigned severity as an absolute gate
    // produces a system that cannot enter a position at all.
    //
    // The pipeline resolves it AFTER the deterministic synthesis, where a weak
    // verdict can be overridden only by measured arithmetic. THESIS_BROKEN and
    // detected confirmation bias remain absolute here: the first says the
    // evidence contradicts the thesis, the second says the reasoning itself is
    // unsound, and no amount of favourable arithmetic redeems either.
    const weakVerdict = challenge.verdict === "THESIS_WEAK";
    // `couldBeFalseSignal` is NOT a veto, and using it as one is why nothing
    // could ever trade.
    //
    // The challenger is explicitly asked whether the setup could be a false
    // signal. For any technical setup the honest answer is yes — it always
    // could be. A possibility that is true of every trade cannot be the thing
    // that decides against this one; treated as a veto it silently made the
    // system incapable of entering a position at all.
    //
    // It belongs where uncertainty belongs: in the confidence, which
    // deriveConfidence already lowers for it, and in the record. The real
    // vetoes remain — a broken thesis, a weak one, and detected confirmation
    // bias are judgements, not possibilities — and every deterministic control
    // after this point is untouched: cost hurdle, risk/reward, position limits,
    // fresh-world revalidation and the risk gate all still decide.
    if (challenge.couldBeFalseSignal && ["BUY", "ADD"].includes(action)) {
        reasons.push(`carrying false-signal risk: ${challenge.falseSignalTell}`);
    }
    if (challenge.confirmationBiasDetected && ["BUY", "ADD"].includes(action)) {
        action = "HOLD";
        reasons.push("confirmation bias detected in the supporting argument");
    }

    return { action, weakVerdict, downgraded: action !== thesis.proposedAction, reasons };
};
