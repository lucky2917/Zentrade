import { NSE_HOLIDAYS } from "../../utils/marketHours.js";

// Explicit market-session model.
//
// `isMarketOpen()` is a boolean, and a boolean cannot express "the market is
// closed but we should still reconcile", or "we are in the closing window so
// no new intraday exposure". Each session state carries its own policy, so a
// scheduler decision is a lookup rather than a scattered condition.

export const SESSION = {
    PRE_MARKET: "PRE_MARKET",
    OPEN: "OPEN",
    CLOSING: "CLOSING",
    CLOSED: "CLOSED",
    HALTED: "HALTED",
};

// IST minutes since midnight.
const OPEN_AT = 9 * 60 + 15;
const PRE_MARKET_AT = 9 * 60;
const CLOSING_AT = 15 * 60 + 20;
const CLOSE_AT = 15 * 60 + 30;

// What each state permits. The scheduler and the risk path both read this, so
// a rule cannot drift between them.
export const SESSION_POLICY = {
    [SESSION.PRE_MARKET]: {
        marketData: true, positionMonitor: true, discovery: false,
        newExposure: false, exits: false, reconciliation: true, reasoning: false,
    },
    [SESSION.OPEN]: {
        marketData: true, positionMonitor: true, discovery: true,
        newExposure: true, exits: true, reconciliation: true, reasoning: true,
    },
    [SESSION.CLOSING]: {
        // No new exposure into the close; exits must stay possible so a
        // position is never trapped by the clock.
        marketData: true, positionMonitor: true, discovery: false,
        newExposure: false, exits: true, reconciliation: true, reasoning: true,
    },
    [SESSION.CLOSED]: {
        marketData: false, positionMonitor: true, discovery: false,
        newExposure: false, exits: false, reconciliation: true, reasoning: false,
    },
    // Unknown state: assume the worst. Positions remain observable and
    // reconciliation continues, but nothing may trade.
    [SESSION.HALTED]: {
        marketData: false, positionMonitor: true, discovery: false,
        newExposure: false, exits: false, reconciliation: true, reasoning: false,
    },
};

export const istPartsOf = (date) => {
    const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
    return {
        weekday: ist.getUTCDay(),
        minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
        dateStr: `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`,
    };
};

export const isTradingDay = (date) => {
    const { weekday, dateStr } = istPartsOf(date);
    if (weekday === 0 || weekday === 6) return false;
    return !NSE_HOLIDAYS.has(dateStr);
};

export const sessionStateAt = (date = new Date(), { halted = false } = {}) => {
    if (halted) return SESSION.HALTED;
    if (!isTradingDay(date)) return SESSION.CLOSED;
    const { minutes } = istPartsOf(date);
    if (minutes < PRE_MARKET_AT) return SESSION.CLOSED;
    if (minutes < OPEN_AT) return SESSION.PRE_MARKET;
    if (minutes < CLOSING_AT) return SESSION.OPEN;
    if (minutes <= CLOSE_AT) return SESSION.CLOSING;
    return SESSION.CLOSED;
};

export const policyFor = (state) => SESSION_POLICY[state] ?? SESSION_POLICY[SESSION.HALTED];

export const permits = (state, capability) => Boolean(policyFor(state)[capability]);
