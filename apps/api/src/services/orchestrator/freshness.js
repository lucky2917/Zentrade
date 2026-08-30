// Concrete data-freshness rules.
//
// "Recent" is not a threshold. Every source that can gate a trading decision
// gets an explicit maximum age, a defined behaviour when it is exceeded, and a
// defined recovery condition.

export const SOURCE = {
    WEBSOCKET: "fyers_websocket",
    REST: "fyers_rest",
    SPINE_INTRADAY: "spine_intraday",
    POSITION_PRICE: "position_price",
};

export const FRESHNESS_RULES = {
    // Ticks arrive continuously while the market is open. Ninety seconds of
    // silence during a session means the feed, not the market, is quiet.
    [SOURCE.WEBSOCKET]: {
        maxAgeMs: 90_000,
        onStale: "no new exposure; exits permitted; connection marked STALE",
        recovery: "a single fresh tick restores CONNECTED",
    },
    // The REST cache is refreshed by the market worker on its own interval, so
    // it tolerates more age than the stream.
    [SOURCE.REST]: {
        maxAgeMs: 300_000,
        onStale: "no new exposure; REST-derived prices not used for sizing",
        recovery: "next successful market worker cycle",
    },
    // Research storage, not a live gate. Staleness here blocks nothing live.
    [SOURCE.SPINE_INTRADAY]: {
        maxAgeMs: 24 * 60 * 60 * 1000,
        onStale: "research reads flagged; live path unaffected",
        recovery: "next backfill",
    },
    // The price attached to an individual position state.
    [SOURCE.POSITION_PRICE]: {
        maxAgeMs: 90_000,
        onStale: "position marked stale; monitor emits DATA_STALE and stops evaluating it",
        recovery: "a fresh tick for that symbol",
    },
};

export const isStale = (source, ageMs) => {
    const rule = FRESHNESS_RULES[source];
    if (!rule) return true;                 // unknown source is never trusted
    if (ageMs === null || ageMs === undefined) return true;
    return ageMs > rule.maxAgeMs;
};

export const maxAgeFor = (source) => FRESHNESS_RULES[source]?.maxAgeMs ?? 0;

// One place that answers "may we add exposure right now?".
export const permitsNewExposure = ({ connectionTrusted, websocketAgeMs }) => {
    if (!connectionTrusted) return { permitted: false, reason: "market data connection not trusted" };
    if (isStale(SOURCE.WEBSOCKET, websocketAgeMs))
        return { permitted: false, reason: `market data stale (${websocketAgeMs}ms)` };
    return { permitted: true, reason: null };
};
