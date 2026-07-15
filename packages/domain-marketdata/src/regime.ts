import { canonicalHash, istDateString } from "@zentrade/kernel";

/**
 * Regime classification — taxonomy `nse_equity_v1` (M12).
 *
 * LAWS:
 *  1. FROZEN TAXONOMY: the constants below define nse_equity_v1 FOREVER.
 *     Changing any threshold, window or formula requires a NEW taxonomy id
 *     (nse_equity_v2, …) — historical labels never silently change, and the
 *     regimes table's primary key makes coexistence natural.
 *  2. DETERMINISM: same candle window -> same label + same inputsHash,
 *     on any machine, any year. Pure function; candles sorted internally.
 *  3. LOW COST: one pass over ~60 sessions of benchmark-index candles.
 *
 * v1 dimensions: TREND (SMA20/SMA50 posture) × VOL (20-session realized,
 * annualized). BREADTH is reserved in the schema but null in v1 — computing
 * honest advance/decline breadth needs per-constituent history we do not
 * store yet; deferring it to a future taxonomy version was chosen over
 * shipping a fake proxy. (Deliberate, documented in the M12 report.)
 */

export const REGIME_TAXONOMY = "nse_equity_v1" as const;

// --- frozen v1 constants (changing any of these = new taxonomy id) ---
const SMA_FAST = 20;
const SMA_SLOW = 50;
const VOL_WINDOW = 20; // sessions of daily log returns
const VOL_LOW_MAX = 12; // annualized %, exclusive upper bound of LOWVOL
const VOL_HIGH_MIN = 20; // annualized %, exclusive lower bound of HIGHVOL
const ANNUALIZATION = Math.sqrt(252);

export const MIN_SESSIONS = SMA_SLOW + 1; // slow SMA plus one prior close for returns

export type Trend = "UP" | "DOWN" | "SIDEWAYS";
export type VolBucket = "LOWVOL" | "MIDVOL" | "HIGHVOL";

export interface RegimeCandle {
    /** epoch seconds (session time) */
    time: number;
    close: number;
}

export interface RegimeLabel {
    ready: true;
    taxonomy: typeof REGIME_TAXONOMY;
    calDate: string; // IST date of the classified session
    trend: Trend;
    volBucket: VolBucket;
    breadth: null; // reserved for a future taxonomy version
    composite: string; // `${trend}_${volBucket}`
    realizedVolPct: number; // recorded for audit; not part of the label key
    inputsHash: string; // canonical hash of the exact window used
}

export interface RegimeNotReady {
    ready: false;
    reason: string;
}

const sma = (values: readonly number[], window: number): number => {
    let sum = 0;
    for (let i = values.length - window; i < values.length; i++) sum += values[i]!;
    return sum / window;
};

/**
 * Classify the regime AS OF the last candle in the window.
 * Extra history beyond MIN_SESSIONS is truncated from the left so that the
 * inputsHash — and therefore the label — is invariant to how much history
 * the caller happened to fetch (replay law).
 */
export const classifyRegime = (candles: readonly RegimeCandle[]): RegimeLabel | RegimeNotReady => {
    const sorted = [...candles]
        .filter((c) => Number.isFinite(c.close) && c.close > 0)
        .sort((a, b) => a.time - b.time);

    if (sorted.length < MIN_SESSIONS) {
        return { ready: false, reason: `need ${MIN_SESSIONS} sessions, have ${sorted.length}` };
    }

    const window = sorted.slice(-MIN_SESSIONS);
    const closes = window.map((c) => c.close);
    const last = window[window.length - 1]!;

    const smaFast = sma(closes, SMA_FAST);
    const smaSlow = sma(closes, SMA_SLOW);
    const close = closes[closes.length - 1]!;

    const trend: Trend =
        close > smaSlow && smaFast > smaSlow ? "UP" : close < smaSlow && smaFast < smaSlow ? "DOWN" : "SIDEWAYS";

    // realized vol: stdev of the last VOL_WINDOW daily log returns, annualized
    const returns: number[] = [];
    for (let i = closes.length - VOL_WINDOW; i < closes.length; i++) {
        returns.push(Math.log(closes[i]! / closes[i - 1]!));
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
    const realizedVolPct = Math.sqrt(variance) * ANNUALIZATION * 100;

    const volBucket: VolBucket =
        realizedVolPct < VOL_LOW_MAX ? "LOWVOL" : realizedVolPct > VOL_HIGH_MIN ? "HIGHVOL" : "MIDVOL";

    return {
        ready: true,
        taxonomy: REGIME_TAXONOMY,
        calDate: istDateString(new Date(last.time * 1000)),
        trend,
        volBucket,
        breadth: null,
        composite: `${trend}_${volBucket}`,
        realizedVolPct: Math.round(realizedVolPct * 100) / 100,
        inputsHash: canonicalHash({ taxonomy: REGIME_TAXONOMY, window: window.map((c) => [c.time, c.close]) }),
    };
};
