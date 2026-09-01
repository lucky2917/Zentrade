import { observeSymbol } from "../intelligence/observe.js";
import { ROUND_TRIP_COST_BPS } from "../reasoning/synthesis.js";

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

// The move the screen judges on. Five minutes when it is available, one minute
// otherwise — and whichever was used is what the ranking below must also use.
export const screenedMove = (context) =>
    context?.mtf?.change5m ?? context?.mtf?.change1m ?? null;

export const screenSymbol = (observation, context, screen = DEFAULT_SCREEN) => {
    const reasons = [];

    const change = screenedMove(context);
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

// Is this candidate worth a decision at all?
//
// The scan path has always applied an economic screen. The EVENT path never
// did: an anomaly detector fires on statistical significance and hands the
// symbol straight to the Senior Trader, so a 0.29% move at 6 sigma was
// reasoned about at the same price as a 7% breakout.
//
// Measured on the 2026-09-01 session: of 33 event-driven candidates, 26
// carried moves of 0.26% to 0.43% against a 73.55 bps round trip, or volume
// and volatility with no direction at all. Every one came back HOLD, and every
// one cost two model calls to reach a conclusion arithmetic could have reached
// for nothing. That is where the session's reasoning budget went, and why the
// candidates that COULD trade queued behind them.
//
// This is not a risk control and it does not decide anything. It asks whether
// a move exists that could pay for the round trip it would take to capture it.
// A move smaller than its own costs cannot produce an executable thesis, so
// there is nothing for a decision to be about.
export const clearsCostHurdle = (context, costBps = ROUND_TRIP_COST_BPS) => {
    const move = screenedMove(context);
    if (move === null) {
        return { worth: false, reason: "no measurable price move to trade" };
    }
    const movePercent = Math.abs(move) * 100;
    const hurdlePercent = costBps / 100;
    if (movePercent < hurdlePercent) {
        return {
            worth: false,
            reason: `move ${movePercent.toFixed(2)}% cannot cover the `
                + `${hurdlePercent.toFixed(2)}% round trip`,
        };
    }
    return { worth: true, movePercent };
};

// Strongest first, ties broken by symbol so the order is deterministic.
//
// Ranked on the SAME move the screen admitted the candidate on. Ranking on
// change5m alone sorted every candidate that qualified on its one-minute move
// as zero, so the strongest of them lost to the weakest five-minute mover —
// and since only the first few are reasoned about, it was never looked at.
//
// Sorts in place and returns the same array.
export const rankCandidates = (candidates) => candidates.sort((a, b) => {
    const byMove = Math.abs(screenedMove(b.context) ?? 0)
        - Math.abs(screenedMove(a.context) ?? 0);
    return byMove !== 0 ? byMove : a.symbol.localeCompare(b.symbol);
});

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

    rankCandidates(candidates);

    return {
        candidates: candidates.slice(0, screen.maxCandidatesPerCycle),
        suppressed: Math.max(0, candidates.length - screen.maxCandidatesPerCycle),
        examined,
    };
};
