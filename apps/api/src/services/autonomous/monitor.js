import { EVENT_TYPES, SEVERITY, makeEvent } from "./events.js";

// The cheap tier of the autonomous loop.
//
// This runs continuously over every open position and costs nothing but
// arithmetic: no LLM, no network, no database writes beyond the events it
// emits. It exists so the expensive reasoning path can stay asleep until
// something actually changes.
//
// Every threshold is explicit and configurable. Nothing here decides to trade;
// it only decides that a human-or-AI-level question is now worth asking.

export const DEFAULT_THRESHOLDS = {
    priceJumpPercent: 2.0,        // absolute move since the last observation
    stopApproachFraction: 0.25,   // within 25% of the entry-to-stop span
    targetApproachFraction: 0.25,
    volatilityExpansionRatio: 2.0,
    volumeSpikeRatio: 3.0,
    portfolioDrawdownPercent: 5.0,
};

// Discretising the observation is what stops a persistent condition from
// re-firing every cycle. A position sitting just past its stop produces one
// STOP_BREACH, not one per second.
const bucketOf = (value, size) => Math.floor(value / size);

export const evaluatePosition = (state, {
    thresholds = DEFAULT_THRESHOLDS, previous = null, now = new Date(),
} = {}) => {
    const events = [];
    const emit = (type, severity, reason, observed, bucket) => {
        events.push(makeEvent({
            type, severity, reason, observed,
            previous: previous ? { pricePaise: previous.currentPricePaise } : null,
            symbol: state.symbol, thesisId: state.thesisId,
            correlationId: state.correlationId ?? `mon-${state.symbol}`,
            source: "position_monitor", observedAt: now, bucket,
        }));
    };

    // Stale data is an infrastructure condition, not a trading signal. It is
    // reported so the risk gate can refuse to act on a price nobody trusts.
    if (state.stale) {
        emit(EVENT_TYPES.DATA_STALE, SEVERITY.WARNING,
            `no fresh tick for ${state.symbol}`,
            { dataAgeMs: state.dataAgeMs }, bucketOf(now.getTime(), 60_000));
        return events;
    }

    // A position with no thesis cannot be reassessed against anything. That is
    // a correctness problem worth surfacing, not a market event.
    if (!state.hasThesis) {
        emit(EVENT_TYPES.POSITION_WITHOUT_THESIS, SEVERITY.WARNING,
            `holding ${state.symbol} with no recorded thesis`,
            { quantity: state.quantity }, "static");
        return events;
    }

    if (state.stopDistance !== null && state.stopDistance <= 0) {
        emit(EVENT_TYPES.STOP_BREACH, SEVERITY.CRITICAL,
            `price breached the stop recorded at entry`,
            { currentPricePaise: state.currentPricePaise, stopPaise: state.stopPaise,
              pnlPercent: state.pnlPercent }, "breached");
    } else if (state.stopDistance !== null && state.stopDistance <= thresholds.stopApproachFraction) {
        emit(EVENT_TYPES.STOP_APPROACHING, SEVERITY.WARNING,
            `within ${Math.round(state.stopDistance * 100)}% of the stop`,
            { stopDistance: state.stopDistance, pnlPercent: state.pnlPercent },
            bucketOf(state.stopDistance, 0.1));
    }

    if (state.targetDistance !== null && state.targetDistance <= 0) {
        emit(EVENT_TYPES.TARGET_BREACH, SEVERITY.WARNING,
            `price reached the target recorded at entry`,
            { currentPricePaise: state.currentPricePaise, targetPaise: state.targetPaise,
              pnlPercent: state.pnlPercent }, "breached");
    } else if (state.targetDistance !== null && state.targetDistance <= thresholds.targetApproachFraction) {
        emit(EVENT_TYPES.TARGET_APPROACHING, SEVERITY.INFO,
            `within ${Math.round(state.targetDistance * 100)}% of the target`,
            { targetDistance: state.targetDistance }, bucketOf(state.targetDistance, 0.1));
    }

    if (previous?.currentPricePaise) {
        const movePercent =
            ((state.currentPricePaise - previous.currentPricePaise) / previous.currentPricePaise) * 100;
        if (Math.abs(movePercent) >= thresholds.priceJumpPercent) {
            emit(EVENT_TYPES.PRICE_JUMP,
                Math.abs(movePercent) >= thresholds.priceJumpPercent * 2
                    ? SEVERITY.CRITICAL : SEVERITY.WARNING,
                `price moved ${movePercent.toFixed(2)}% since the last observation`,
                { movePercent, currentPricePaise: state.currentPricePaise },
                bucketOf(now.getTime(), 60_000));
        }
    }

    return events;
};

// Portfolio-level conditions, evaluated once per cycle rather than per symbol.
export const evaluatePortfolio = (portfolio, {
    thresholds = DEFAULT_THRESHOLDS, now = new Date(),
} = {}) => {
    const events = [];
    const invested = portfolio.grossExposurePaise;
    if (invested > 0) {
        const drawdownPercent = (portfolio.unrealisedPnlPaise / invested) * 100;
        if (drawdownPercent <= -thresholds.portfolioDrawdownPercent) {
            events.push(makeEvent({
                type: EVENT_TYPES.PORTFOLIO_DRAWDOWN, severity: SEVERITY.CRITICAL,
                symbol: "PORTFOLIO", thesisId: null,
                correlationId: `portfolio-${portfolio.userId}`,
                source: "position_monitor",
                observed: { drawdownPercent, unrealisedPnlPaise: portfolio.unrealisedPnlPaise },
                reason: `portfolio drawdown ${drawdownPercent.toFixed(2)}%`,
                observedAt: now, bucket: bucketOf(drawdownPercent, 1),
            }));
        }
    }
    return events;
};

// One monitor pass. Pure: it takes state in and returns events out, so it can
// be driven by a scheduler in production and by a fixed sequence in a test.
export const runMonitorCycle = ({ positions, portfolio, previousBySymbol = new Map(),
                                  thresholds = DEFAULT_THRESHOLDS, now = new Date() }) => {
    const events = [];
    for (const state of positions) {
        events.push(...evaluatePosition(state, {
            thresholds, previous: previousBySymbol.get(state.symbol) ?? null, now,
        }));
    }
    if (portfolio) events.push(...evaluatePortfolio(portfolio, { thresholds, now }));
    return events;
};
