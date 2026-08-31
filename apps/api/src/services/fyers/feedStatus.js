// Is the websocket actually delivering ticks?
//
// REST is a BACKSTOP, not a second market-data path. Three pollers were hitting
// quotes and depth for the same 200 symbols the socket was already streaming —
// the depth lane alone is 20 calls every 15 seconds, which is 80 a minute
// against a 180/minute ceiling and a 100,000/day budget. That is how "request
// limit reached" arrives, and once the budget is gone the backstop is gone too,
// exactly when it would be needed.
//
// One tracker already exists and already knows the answer. This is a registry
// so the pollers can ask it without importing the server, and without a second
// tracker being created to answer the same question.

let tracker = null;

export const setFeedTracker = (t) => { tracker = t; };

// Conservative by design: an unknown feed is treated as NOT trusted, so the
// backstop runs. Being wrong in that direction costs REST budget; being wrong
// the other way costs market data.
export const feedIsTrusted = () => {
    try { return Boolean(tracker?.isTrusted?.()); } catch { return false; }
};

export const feedStatus = () => {
    try { return tracker?.health?.() ?? { state: "UNKNOWN", trusted: false }; }
    catch { return { state: "UNKNOWN", trusted: false }; }
};
