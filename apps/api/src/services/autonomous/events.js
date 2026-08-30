// Typed domain events for the autonomous loop.
//
// These are MARKET and POSITION events. Infrastructure alarms stay in
// opsAlarms.js — conflating "the outbox is lagging" with "this stock just
// broke down" would route an engineering problem into a trading decision.
//
// Every event carries a deterministic `key`. Re-observing the same condition
// in the same state produces the same key, so the UNIQUE constraint on
// position_events makes duplicate reasoning impossible, including across a
// restart.

export const EVENT_TYPES = {
    PRICE_JUMP: "PRICE_JUMP",
    STOP_APPROACHING: "STOP_APPROACHING",
    TARGET_APPROACHING: "TARGET_APPROACHING",
    STOP_BREACH: "STOP_BREACH",
    TARGET_BREACH: "TARGET_BREACH",
    VOLATILITY_EXPANSION: "VOLATILITY_EXPANSION",
    VOLUME_SPIKE: "VOLUME_SPIKE",
    TECHNICAL_BREAKDOWN: "TECHNICAL_BREAKDOWN",
    BREAKOUT_FAILURE: "BREAKOUT_FAILURE",
    THESIS_INVALIDATED: "THESIS_INVALIDATED",
    REGIME_CHANGE: "REGIME_CHANGE",
    NEWS_EVENT: "NEWS_EVENT",
    PORTFOLIO_DRAWDOWN: "PORTFOLIO_DRAWDOWN",
    DATA_STALE: "DATA_STALE",
    POSITION_WITHOUT_THESIS: "POSITION_WITHOUT_THESIS",
};

export const SEVERITY = { INFO: "INFO", WARNING: "WARNING", CRITICAL: "CRITICAL" };

// Which events justify waking the expensive reasoning path. INFO events are
// recorded for the audit trail but do not spend an LLM call.
export const REASONING_SEVERITIES = new Set([SEVERITY.WARNING, SEVERITY.CRITICAL]);

export const ROUTE = {
    POSITION: "POSITION",
    CANDIDATE: "CANDIDATE",
    MARKET: "MARKET",
    INFRASTRUCTURE: "INFRASTRUCTURE",
};

// Conditions describing the system's own state rather than the market.
//
// POSITION_WITHOUT_THESIS belongs here even though it names a symbol. Routing
// it by "carries no thesis id" classified it as a name we were merely watching,
// which is the one thing it is not: the account already holds it. The candidate
// path would then be asked whether to BUY a position it cannot explain.
const INFRASTRUCTURE_EVENTS = new Set([
    EVENT_TYPES.DATA_STALE,
    EVENT_TYPES.POSITION_WITHOUT_THESIS,
]);
const MARKET_EVENTS = new Set([EVENT_TYPES.REGIME_CHANGE, EVENT_TYPES.PORTFOLIO_DRAWDOWN]);

// Where an event belongs. An event attached to a thesis concerns a position we
// hold; the same type without one concerns a name we are only watching.
export const routeOf = (event) => {
    if (INFRASTRUCTURE_EVENTS.has(event.type)) return ROUTE.INFRASTRUCTURE;
    if (MARKET_EVENTS.has(event.type)) return ROUTE.MARKET;
    return event.thesisId ? ROUTE.POSITION : ROUTE.CANDIDATE;
};

export const requiresReasoning = (event) =>
    REASONING_SEVERITIES.has(event.severity) && routeOf(event) === ROUTE.POSITION;

// The IST session date an observation belongs to. Event identity is scoped to
// it because `position_events.event_key` is UNIQUE for the life of the
// database: without a date, the first PRICE_JUMP on a symbol would suppress
// every later one forever, including on subsequent trading days.
export const sessionDateOf = (observedAt) => {
    const at = observedAt instanceof Date ? observedAt : new Date(observedAt);
    if (Number.isNaN(at.getTime())) return "undated";
    return new Date(at.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

// Deterministic identity. `bucket` discretises the observation so a condition
// that persists across cycles collapses to one event instead of firing every
// tick, while a genuinely new occurrence produces a new key. Dedup within a
// session is unchanged; a new session starts a new key space.
export const eventKey = ({ type, symbol, thesisId, bucket, sessionDate }) =>
    [sessionDate ?? "undated", type, symbol, thesisId ?? "none", bucket ?? "0"].join(":");

export const makeEvent = ({
    type, symbol, severity, thesisId = null, correlationId,
    source, observed, previous = null, reason, observedAt, bucket,
}) => {
    if (!EVENT_TYPES[type]) throw new Error(`unknown event type: ${type}`);
    if (!SEVERITY[severity]) throw new Error(`unknown severity: ${severity}`);
    if (!symbol) throw new Error("event requires a symbol");
    if (!reason) throw new Error("event requires a reason");
    if (!observedAt) throw new Error("event requires observedAt");
    return {
        key: eventKey({ type, symbol, thesisId, bucket,
                        sessionDate: sessionDateOf(observedAt) }),
        type, symbol, severity, thesisId, correlationId, source,
        observed, previous, reason,
        observedAt: observedAt instanceof Date ? observedAt.toISOString() : observedAt,
    };
};
