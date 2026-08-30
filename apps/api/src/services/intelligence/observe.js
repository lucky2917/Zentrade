import { phaseAt, minutesIntoSession } from "./sessionPhase.js";
import { vwapUpTo, vwapDistance } from "./vwap.js";
import { buildMtfContext } from "./mtf.js";
import { detectSymbolAnomalies, detectMarketWideMove } from "./anomaly.js";

// The bridge between raw observation and the event system.
//
// Assembles the deterministic market context for one symbol, runs the
// detectors over it, and returns context plus events. It performs no I/O and
// calls nothing downstream: the orchestrator decides what to do with what
// comes back. This module cannot reach execution.

export const buildObservation = ({
    symbol, bars1m = [], bars5m = [], bars15m = [], price, asOf,
    thesisId = null, correlationId = null, calculatedAt = null,
}) => {
    const when = asOf instanceof Date ? asOf : new Date(asOf);

    const vwapResult = bars1m.length
        ? vwapUpTo(bars1m, when.toISOString())
        : { vwap: null, barsUsed: 0, available: false, asOf: when.toISOString() };

    const mtf = buildMtfContext({ bars1m, bars5m, bars15m, asOf: when });

    return {
        symbol,
        asOf: when.toISOString(),
        // Calculation time is kept apart from observation time so a slow cycle
        // cannot make stale data look current. It is injectable because a
        // wall-clock read inside an otherwise deterministic function would
        // break replay.
        calculatedAt: calculatedAt
            ? new Date(calculatedAt).toISOString() : new Date().toISOString(),
        price: Number.isFinite(price) ? price : null,
        sessionPhase: phaseAt(when),
        minutesIntoSession: minutesIntoSession(when),
        vwap: vwapResult.vwap,
        vwapAvailable: vwapResult.available,
        vwapBarsUsed: vwapResult.barsUsed,
        vwapDistance: vwapDistance(price, vwapResult.vwap),
        mtf,
        barsSeen: { m1: bars1m.length, m5: bars5m.length, m15: bars15m.length },
        thesisId,
        correlationId,
    };
};

// Runs the detectors for one symbol against its own history.
export const observeSymbol = (input) => {
    const context = buildObservation(input);
    const bars = input.bars1m ?? [];
    const index = bars.length - 1;

    // Nothing to compare against yet: report the context and emit nothing.
    if (index < 1) return { context, events: [] };

    const events = detectSymbolAnomalies({
        bars, index, symbol: input.symbol, asOf: context.asOf,
        thesisId: input.thesisId ?? null, correlationId: input.correlationId ?? null,
        price: context.price ?? undefined,
        vwap: context.vwapAvailable ? context.vwap : undefined,
    });

    return { context, events };
};

// One pass across the observed universe. Symbol detectors run per symbol; the
// market-wide detector runs once over the aggregate, so a single company's
// move never wakes every symbol's reasoning.
export const observeUniverse = ({ observations, asOf, correlationId = null,
                                 calculatedAt = null }) => {
    const contexts = {};
    const events = [];
    const moves = {};

    for (const observation of observations) {
        const { context, events: symbolEvents } =
            observeSymbol({ ...observation, asOf, calculatedAt });
        contexts[observation.symbol] = context;
        events.push(...symbolEvents);

        const bars = observation.bars1m ?? [];
        if (bars.length >= 2) {
            const prev = bars[bars.length - 2].close;
            const cur = bars[bars.length - 1].close;
            if (Number.isFinite(prev) && Number.isFinite(cur) && prev > 0) {
                moves[observation.symbol] = (cur - prev) / prev;
            }
        }
    }

    const marketEvent = detectMarketWideMove({ moves, asOf, correlationId });
    if (marketEvent) events.push(marketEvent);

    return {
        contexts, events, moves,
        symbolsObserved: observations.length,
        marketWide: Boolean(marketEvent),
    };
};
