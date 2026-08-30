// What the market as a whole is doing.
//
// The market-wide detector already existed and its output had no consumer: a
// REGIME_CHANGE event routed to a branch that returned "not a position event".
// So the brain screened individual stocks for 1% moves while the index fell
// apart, with nothing in its evidence saying so.
//
// This is not an event. It is a state, assembled every bar and injected into
// every decision, because "is the whole market falling" is context for a view,
// not an interruption to one.
//
// Deterministic and measured. No model, no forecast, no invented data source:
// it is computed from the same observations the symbol detectors already use.

export const BREADTH = {
    BROAD_DECLINE: "BROAD_DECLINE",
    DECLINING: "DECLINING",
    MIXED: "MIXED",
    ADVANCING: "ADVANCING",
    BROAD_ADVANCE: "BROAD_ADVANCE",
    UNKNOWN: "UNKNOWN",
};

// Below this many observed symbols, breadth is not a measurement, it is noise.
export const MIN_SYMBOLS_FOR_BREADTH = 10;

// Share of the universe moving the same way before it counts as synchronised.
export const SYNCHRONISED_FRACTION = 0.6;
export const STRONG_SYNCHRONISED_FRACTION = 0.75;

// Median absolute move that makes a synchronised market a shock rather than a drift.
export const SHOCK_MOVE = 0.01;      // 1%
export const SEVERE_SHOCK_MOVE = 0.02;

const median = (xs) => {
    if (!xs.length) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const buildMarketState = ({ moves = {}, asOf = null } = {}) => {
    const values = Object.values(moves).filter(Number.isFinite);
    const observed = values.length;

    if (observed < MIN_SYMBOLS_FOR_BREADTH) {
        return {
            asOf: asOf ? new Date(asOf).toISOString() : null,
            breadth: BREADTH.UNKNOWN,
            symbolsObserved: observed,
            advancingFraction: null, decliningFraction: null,
            synchronisedFraction: null, medianAbsMove: null, medianMove: null,
            shock: false, severeShock: false, direction: null,
            basis: `only ${observed} symbols observed; breadth needs ${MIN_SYMBOLS_FOR_BREADTH}`,
        };
    }

    const advancing = values.filter((m) => m > 0).length;
    const declining = values.filter((m) => m < 0).length;
    const advancingFraction = advancing / observed;
    const decliningFraction = declining / observed;
    const dominant = Math.max(advancing, declining);
    const synchronisedFraction = dominant / observed;
    const direction = declining > advancing ? "DOWN" : advancing > declining ? "UP" : null;
    const medianAbsMove = median(values.map(Math.abs));
    const shock = synchronisedFraction >= SYNCHRONISED_FRACTION && medianAbsMove >= SHOCK_MOVE;
    const severeShock = synchronisedFraction >= SYNCHRONISED_FRACTION
        && medianAbsMove >= SEVERE_SHOCK_MOVE;

    let breadth = BREADTH.MIXED;
    if (synchronisedFraction >= STRONG_SYNCHRONISED_FRACTION) {
        breadth = direction === "DOWN" ? BREADTH.BROAD_DECLINE : BREADTH.BROAD_ADVANCE;
    } else if (synchronisedFraction >= SYNCHRONISED_FRACTION) {
        breadth = direction === "DOWN" ? BREADTH.DECLINING : BREADTH.ADVANCING;
    }

    return {
        asOf: asOf ? new Date(asOf).toISOString() : null,
        breadth,
        symbolsObserved: observed,
        advancingFraction, decliningFraction, synchronisedFraction,
        medianAbsMove, medianMove: median(values),
        shock, severeShock, direction,
        basis: `${Math.round(synchronisedFraction * 100)}% of ${observed} symbols moving ` +
               `${direction ?? "mixed"}, median absolute move ${(medianAbsMove * 100).toFixed(2)}%`,
    };
};

export const UNKNOWN_MARKET = buildMarketState({});

// The deterministic protective rule. A senior trader does not add long
// exposure into a synchronised decline because one chart looks good, and this
// is not a judgement the model is allowed to overrule.
export const blocksNewExposure = (marketState, side = "BUY") => {
    if (!marketState || !marketState.shock) return null;
    const against = side === "SELL" ? marketState.direction === "UP" : marketState.direction === "DOWN";
    if (!against) return null;
    return {
        blocked: true,
        reason: `market-wide ${marketState.direction === "DOWN" ? "decline" : "advance"}: ${marketState.basis}`,
        severe: marketState.severeShock,
    };
};
