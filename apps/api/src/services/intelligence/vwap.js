// Intraday session VWAP.
//
// The existing computeVWAP in technicalIndicators.js is a ROLLING 20-bar VWAP.
// Session VWAP is a different quantity: it resets at the opening bell and
// accumulates across the day, which is what "price is above VWAP" normally
// means to a trader. Both are legitimate; this adds the missing one rather
// than changing the existing one.
//
// PIT-safe by construction: it accumulates forward only, so the value at bar N
// uses bars 1..N and never looks ahead.
//
// STATUS: operational context for the live agent. NOT a research feature. Using
// it predictively requires a new pre-registered block experiment.

import { istMinutesOf } from "./sessionPhase.js";

const SESSION_OPEN_IST = 9 * 60 + 15;

export const typicalPrice = (bar) => (bar.high + bar.low + bar.close) / 3;

// Bars must be same-session and chronological. Anything with no volume
// contributes nothing: including it would drag VWAP toward an untraded price.
export const sessionVwap = (bars) => {
    let sumPV = 0;
    let sumV = 0;
    let counted = 0;
    for (const bar of bars) {
        if (!Number.isFinite(bar.volume) || bar.volume <= 0) continue;
        if (![bar.high, bar.low, bar.close].every(Number.isFinite)) continue;
        sumPV += typicalPrice(bar) * bar.volume;
        sumV += bar.volume;
        counted += 1;
    }
    if (sumV <= 0 || counted === 0) return null;
    return sumPV / sumV;
};

// Splits a bar stream into sessions by IST calendar day, so a multi-day series
// cannot leak yesterday's volume into today's VWAP.
export const sessionKeyOf = (bar) => {
    const ist = new Date(new Date(bar.ts).getTime() + 5.5 * 60 * 60 * 1000);
    return ist.toISOString().slice(0, 10);
};

export const vwapUpTo = (bars, asOf) => {
    const cutoff = new Date(asOf).getTime();
    const key = sessionKeyOf({ ts: asOf });
    const sameSession = bars.filter((b) => {
        const t = new Date(b.ts).getTime();
        // Strictly at or before as_of, same session, and at/after the bell.
        return t <= cutoff && sessionKeyOf(b) === key
            && istMinutesOf(new Date(b.ts)) >= SESSION_OPEN_IST;
    });
    const value = sessionVwap(sameSession);
    return {
        vwap: value,
        barsUsed: sameSession.length,
        available: value !== null,
        asOf: new Date(asOf).toISOString(),
    };
};

// Distance from VWAP as a fraction. Positive means price is above VWAP.
export const vwapDistance = (price, vwap) => {
    if (vwap === null || vwap === undefined || vwap <= 0) return null;
    if (!Number.isFinite(price)) return null;
    return (price - vwap) / vwap;
};
