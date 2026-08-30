import { observeSymbol } from "../intelligence/observe.js";

// Deterministic candidate screening.
//
// Answers "which symbols are worth an expensive look" using arithmetic only.
// It does NOT decide to trade: a screen firing produces a candidate, and a
// candidate still passes AI reasoning, the risk gate and the execution state
// machine before anything happens.
//
// It deliberately reuses the existing intelligence rather than introducing a
// predictive model. No new research feature is created here.

export const DEFAULT_SCREEN = {
    minAbsMovePercent: 1.0,      // something must actually be happening
    requireMtfComplete: true,    // do not judge on partial information
    requireAlignment: false,     // alignment is evidence, not a gate
    maxCandidatesPerCycle: 5,    // bounds the LLM budget per scan
    excludeHeld: true,           // a held symbol goes to reassessment instead
};

export const screenSymbol = (observation, context, screen = DEFAULT_SCREEN) => {
    const reasons = [];

    const change = context.mtf?.change5m ?? context.mtf?.change1m ?? null;
    if (change === null) return { passed: false, reasons: ["no usable price change"] };

    const movePercent = Math.abs(change) * 100;
    if (movePercent < screen.minAbsMovePercent) {
        return { passed: false, reasons: [`move ${movePercent.toFixed(2)}% below floor`] };
    }
    reasons.push(`move ${movePercent.toFixed(2)}%`);

    if (screen.requireMtfComplete && !context.mtf?.complete) {
        return { passed: false, reasons: ["multi-timeframe context incomplete"] };
    }
    if (context.mtf?.complete) reasons.push(`mtf ${context.mtf.aligned ? "aligned" : "mixed"}`);

    if (screen.requireAlignment && !context.mtf?.aligned) {
        return { passed: false, reasons: ["timeframes not aligned"] };
    }

    // A stale observation cannot justify new exposure, so it cannot justify
    // spending a reasoning call on entering one either.
    if (observation.stale) return { passed: false, reasons: ["observation stale"] };

    return { passed: true, reasons };
};

// One screening pass. Held symbols are excluded: an anomaly on something we
// own is a reassessment question, not a discovery question.
export const scanUniverse = ({
    observations, heldSymbols = new Set(), asOf, screen = DEFAULT_SCREEN, calculatedAt = null,
}) => {
    const candidates = [];
    const examined = [];

    for (const observation of observations) {
        if (screen.excludeHeld && heldSymbols.has(observation.symbol)) {
            examined.push({ symbol: observation.symbol, passed: false, reasons: ["already held"] });
            continue;
        }
        const { context } = observeSymbol({ ...observation, asOf, calculatedAt });
        const verdict = screenSymbol(observation, context, screen);
        examined.push({ symbol: observation.symbol, ...verdict });
        if (verdict.passed) candidates.push({ symbol: observation.symbol, context, reasons: verdict.reasons });
    }

    // Deterministic ordering, then a hard cap so a volatile session cannot
    // turn one scan into an unbounded number of LLM calls.
    candidates.sort((a, b) => {
        const byMove = Math.abs(b.context.mtf?.change5m ?? 0) - Math.abs(a.context.mtf?.change5m ?? 0);
        return byMove !== 0 ? byMove : a.symbol.localeCompare(b.symbol);
    });

    return {
        candidates: candidates.slice(0, screen.maxCandidatesPerCycle),
        suppressed: Math.max(0, candidates.length - screen.maxCandidatesPerCycle),
        examined,
    };
};
