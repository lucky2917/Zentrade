import { DEFAULT_LIMITS } from "../autonomous/riskGate.js";
import { TIER, makeEvidence } from "./evidence.js";
import { memoryEvidence, summariseMemories } from "../memory/repository.js";

// TraderState: one typed structure describing everything known at a decision
// point, assembled deterministically before any LLM call.
//
// The model reasons over this. It never sees raw ticks, and it never has to
// decide what is measured versus inferred, because that is settled here.

export const REGIME = {
    TRENDING: "TRENDING", RANGING: "RANGING",
    HIGH_VOLATILITY: "HIGH_VOLATILITY", LOW_VOLATILITY: "LOW_VOLATILITY",
    UNKNOWN: "UNKNOWN",
};

// Regime is derived only from evidence we actually hold. The frozen M12
// taxonomy (regimeLabeler) is a DAILY label; intraday volatility state comes
// from the MTF context. Where neither supports a claim the answer is UNKNOWN,
// and the model is told so rather than being left to guess.
export const deriveRegime = ({ dailyRegimeTag = null, mtf = null }) => {
    const evidence = [];
    let regime = REGIME.UNKNOWN;
    let basis = "no regime evidence available";

    if (dailyRegimeTag?.label) {
        evidence.push(makeEvidence({
            tier: TIER.FACT, source: "regimeLabeler",
            statement: `daily regime label is ${dailyRegimeTag.label}`,
            value: dailyRegimeTag.taxonomy,
        }));
        const label = String(dailyRegimeTag.label).toUpperCase();
        if (label.includes("TREND")) { regime = REGIME.TRENDING; basis = "daily taxonomy"; }
        else if (label.includes("RANGE")) { regime = REGIME.RANGING; basis = "daily taxonomy"; }
    }

    if (mtf?.volatilityRatio !== null && mtf?.volatilityRatio !== undefined) {
        evidence.push(makeEvidence({
            tier: TIER.OBSERVATION, source: "mtf",
            statement: `short-horizon volatility is ${mtf.volatilityRatio.toFixed(2)}x the 15m horizon`,
            value: mtf.volatilityRatio,
        }));
        if (mtf.volatilityExpanding && regime === REGIME.UNKNOWN) {
            regime = REGIME.HIGH_VOLATILITY;
            basis = "intraday volatility expansion";
        }
    }

    return { regime, basis, evidence };
};

// Deterministic evidence about the symbol. Every entry is measured, so every
// entry is FACT or OBSERVATION.
const symbolEvidence = (context) => {
    const evidence = [];
    if (Number.isFinite(context?.price)) {
        evidence.push(makeEvidence({
            tier: TIER.FACT, source: "tick",
            statement: `last price is ${context.price}`, value: context.price }));
    }
    if (context?.vwapAvailable && Number.isFinite(context.vwapDistance)) {
        const side = context.vwapDistance >= 0 ? "above" : "below";
        evidence.push(makeEvidence({
            tier: TIER.FACT, source: "session vwap",
            statement: `price is ${(Math.abs(context.vwapDistance) * 100).toFixed(2)}% ${side} session VWAP`,
            value: context.vwapDistance }));
    } else {
        evidence.push(makeEvidence({
            tier: TIER.FACT, source: "session vwap",
            statement: "session VWAP is unavailable for this symbol" }));
    }

    // Volume, measured against the symbol's own baseline.
    //
    // This was absent entirely. The formation prompt names volume expansion as
    // one of the three things that make measured evidence converge, and the
    // challenge prompt names it again — while the state handed to both carried
    // no volume at all. The trader was asked to confirm on evidence it was
    // never given, and told not to invent any, so it could only decline.
    if (Number.isFinite(context?.volumeRatio)) {
        evidence.push(makeEvidence({
            tier: TIER.FACT, source: "volume",
            statement: `last minute traded ${context.volumeRatio.toFixed(2)}x its `
                + `${context.volumeBaselineSamples ?? 0}-bar median volume`,
            value: context.volumeRatio }));
    } else {
        evidence.push(makeEvidence({
            tier: TIER.FACT, source: "volume",
            statement: "volume against baseline is not available for this symbol" }));
    }

    const mtf = context?.mtf;
    if (mtf?.complete) {
        evidence.push(makeEvidence({
            tier: TIER.FACT, source: "mtf",
            statement: `1m ${mtf.direction1m}, 5m ${mtf.direction5m}, 15m ${mtf.direction15m}` +
                (mtf.aligned ? " (aligned)" : mtf.conflict ? " (CONFLICT)" : " (mixed)") }));
    } else {
        evidence.push(makeEvidence({
            tier: TIER.FACT, source: "mtf",
            statement: `multi-timeframe context incomplete; ${mtf?.timeframesKnown ?? 0} of 3 known` }));
    }

    if (Number.isFinite(context?.barsSeen?.m1)) {
        evidence.push(makeEvidence({
            tier: TIER.FACT, source: "bars",
            statement: `${context.barsSeen.m1} one-minute bars observed this session`,
            value: context.barsSeen.m1 }));
    }
    return evidence;
};

// Breadth is measured across the observed universe, so it is an OBSERVATION:
// counted, not inferred, but a summary rather than a single quoted fact.
const marketEvidence = (market) => {
    if (!market || market.breadth === "UNKNOWN") {
        return [makeEvidence({
            tier: TIER.FACT, source: "market breadth",
            statement: "market-wide breadth is not measured in this cycle; "
                     + "this is not evidence that the market is calm" })];
    }
    const evidence = [makeEvidence({
        tier: TIER.OBSERVATION, source: "market breadth",
        statement: `market breadth is ${market.breadth}: ${market.basis}`,
        value: market.synchronisedFraction })];
    if (market.shock) {
        evidence.push(makeEvidence({
            tier: TIER.FACT, source: "market breadth",
            statement: `market-wide ${market.direction === "DOWN" ? "decline" : "advance"} in progress`
                     + `${market.severeShock ? " (severe)" : ""}`,
            value: market.medianAbsMove }));
    }
    return evidence;
};

const eventEvidence = (event) => {
    if (!event) return [];
    return [makeEvidence({
        tier: TIER.OBSERVATION, source: `detector:${event.observed?.detector ?? event.source}`,
        statement: `${event.type} (${event.severity}): ${event.reason}`,
        value: JSON.stringify(event.observed ?? {}).slice(0, 240),
    })];
};

const newsEvidence = (news = []) => news.slice(0, 5).map((n) => makeEvidence({
    tier: TIER.FACT, source: `news:${n.source}`,
    statement: `${n.category} (${n.materiality}) disseminated ${n.disseminatedAt}: ${n.subject}`,
}));

export const buildTraderState = ({
    symbol, context, event = null, position = null, thesis = null,
    portfolio = null, news = [], dailyRegimeTag = null, riskState = null,
    previousAssessment = null, screenReasons = [], market = null, memories = [],
    asOf,
}) => {
    const regime = deriveRegime({ dailyRegimeTag, mtf: context?.mtf });

    return {
        asOf: asOf ? new Date(asOf).toISOString() : context?.asOf ?? null,
        symbol,

        screenReasons: Array.isArray(screenReasons) ? screenReasons.slice(0, 8) : [],

        market: {
            sessionPhase: context?.sessionPhase ?? null,
            minutesIntoSession: context?.minutesIntoSession ?? null,
            regime: regime.regime,
            regimeBasis: regime.basis,
            dataStale: Boolean(position?.stale ?? context?.stale),
            // What the rest of the market is doing. A view on one symbol formed
            // without this is the tunnel vision the red team named.
            breadth: market?.breadth ?? "UNKNOWN",
            breadthBasis: market?.basis ?? "market breadth not measured",
            synchronisedFraction: market?.synchronisedFraction ?? null,
            medianAbsMove: market?.medianAbsMove ?? null,
            direction: market?.direction ?? null,
            shock: Boolean(market?.shock),
            severeShock: Boolean(market?.severeShock),
        },

        symbolState: {
            price: context?.price ?? null,
            vwap: context?.vwap ?? null,
            vwapDistance: context?.vwapDistance ?? null,
            vwapAvailable: Boolean(context?.vwapAvailable),
            mtf: context?.mtf ?? null,
            barsSeen: context?.barsSeen ?? null,
        },

        // Null for a candidate. Present means this is a management question,
        // not an entry question, and the prompts differ accordingly.
        position: position ? {
            quantity: position.quantity,
            entryPricePaise: position.entryPricePaise,
            currentPricePaise: position.currentPricePaise,
            unrealisedPnlPaise: position.unrealisedPnlPaise,
            pnlPercent: position.pnlPercent,
            holdingSeconds: position.holdingSeconds,
            exposurePaise: position.exposurePaise,
            stopDistance: position.stopDistance,
            targetDistance: position.targetDistance,
        } : null,

        // What was believed at ENTRY. Immutable.
        originalThesis: thesis ? {
            id: thesis.id,
            rationale: thesis.rationale,
            setupType: thesis.setup_type ?? thesis.setupType,
            invalidationConditions: thesis.invalidation_conditions ?? thesis.invalidationConditions,
            horizon: thesis.horizon,
            stopPaise: thesis.stop_paise ?? thesis.stopPaise,
            targetPaise: thesis.target_paise ?? thesis.targetPaise,
            openedAt: thesis.opened_at ?? thesis.openedAt,
        } : null,

        // What was believed at the LAST reassessment. Separate from the entry
        // thesis on purpose: belief moves, the record of entry does not.
        previousAssessment: previousAssessment ? {
            action: previousAssessment.action,
            thesisStillValid: previousAssessment.thesis_still_valid ?? previousAssessment.thesisStillValid,
            whatChanged: previousAssessment.what_changed ?? previousAssessment.whatChanged,
            at: previousAssessment.created_at ?? previousAssessment.at,
        } : null,

        trigger: event ? {
            type: event.type, severity: event.severity, reason: event.reason,
            observedAt: event.observedAt, source: event.source,
        } : null,

        risk: {
            cashPaise: portfolio?.cashPaise ?? null,
            // The ceiling the risk gate will actually enforce, so the proposal
            // can be sized under it rather than refused for exceeding it.
            maxPositionValuePaise: DEFAULT_LIMITS.positionValuePaise,
            positionCount: portfolio?.positionCount ?? null,
            grossExposurePaise: portfolio?.grossExposurePaise ?? null,
            unrealisedPnlPaise: portfolio?.unrealisedPnlPaise ?? null,
            unresolvedAmbiguity: riskState?.unresolvedAmbiguity ?? null,
            sessionTrades: riskState?.sessionTrades ?? null,
        },

        news: news.slice(0, 5),

        // What happened the last times a decision like this one was made.
        // Presented as record, never as recommendation: contradictory episodes
        // appear together and the reasoning resolves them.
        memory: {
            summary: summariseMemories(memories),
            episodes: memories.slice(0, 8).map((m) => ({
                date: m.decisionDate, action: m.action, regime: m.regime,
                confidence: m.confidence, hit: m.hit,
                realizedReturnBps: m.realizedReturnBps,
            })),
        },

        evidence: [
            ...marketEvidence(market),
            ...regime.evidence,
            ...symbolEvidence(context),
            ...eventEvidence(event),
            ...newsEvidence(news),
            ...memoryEvidence(memories),
        ],
    };
};
