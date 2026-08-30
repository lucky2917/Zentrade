// Intraday multi-timeframe context across real 1m / 5m / 15m bars.
//
// RESEARCH BOUNDARY, stated because it matters:
// Feature block 2 (mtf_alignment) was tested on DAILY horizons and REJECTED —
// 0 of 12 configurations significant at t>2.86. That verdict stands and is not
// overturned by intraday data existing. This module is LIVE AGENT CONTEXT
// ONLY: it is not fitted, not scored, not promoted, and does not enter the
// active schema. Using it predictively requires a NEW pre-registered
// experiment under the block protocol.
//
// Deterministic and PIT-safe: every value is computed from bars at or before
// the observation, never after.

export const DIRECTION = { UP: "UP", DOWN: "DOWN", FLAT: "FLAT" };

// A move smaller than this is noise, not direction. Chosen so a single tick of
// a liquid large-cap does not flip a timeframe's reported direction.
export const FLAT_THRESHOLD = 0.0005;   // 5 bps

export const MIN_BARS = 3;

export const directionOf = (bars, { flatThreshold = FLAT_THRESHOLD } = {}) => {
    if (!Array.isArray(bars) || bars.length < MIN_BARS) return null;   // insufficient history
    const first = bars[0]?.close;
    const last = bars[bars.length - 1]?.close;
    if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return null;
    const change = (last - first) / first;
    if (Math.abs(change) < flatThreshold) return DIRECTION.FLAT;
    return change > 0 ? DIRECTION.UP : DIRECTION.DOWN;
};

export const changeOf = (bars) => {
    if (!Array.isArray(bars) || bars.length < 2) return null;
    const first = bars[0]?.close;
    const last = bars[bars.length - 1]?.close;
    if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0) return null;
    return (last - first) / first;
};

// Realised volatility as the standard deviation of bar-to-bar returns.
export const realisedVolatility = (bars) => {
    if (!Array.isArray(bars) || bars.length < MIN_BARS) return null;
    const returns = [];
    for (let i = 1; i < bars.length; i += 1) {
        const prev = bars[i - 1].close;
        const cur = bars[i].close;
        if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0) continue;
        returns.push((cur - prev) / prev);
    }
    if (returns.length < 2) return null;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
    return Math.sqrt(variance);
};

export const buildMtfContext = ({ bars1m = [], bars5m = [], bars15m = [], asOf }) => {
    const d1 = directionOf(bars1m);
    const d5 = directionOf(bars5m);
    const d15 = directionOf(bars15m);
    const known = [d1, d5, d15].filter((d) => d !== null);

    const nonFlat = known.filter((d) => d !== DIRECTION.FLAT);
    const up = nonFlat.filter((d) => d === DIRECTION.UP).length;
    const down = nonFlat.filter((d) => d === DIRECTION.DOWN).length;

    // Alignment requires all three known and all pointing the same non-flat
    // way. Conflict requires genuine disagreement, not merely one flat leg.
    const aligned = known.length === 3 && nonFlat.length === 3 && (up === 3 || down === 3);
    const conflict = up > 0 && down > 0;

    const vol1m = realisedVolatility(bars1m);
    const vol15m = realisedVolatility(bars15m);
    // >1 means short-horizon volatility exceeds the longer horizon: expansion.
    const volatilityRatio = vol1m !== null && vol15m !== null && vol15m > 0
        ? vol1m / vol15m : null;

    return {
        asOf: asOf ? new Date(asOf).toISOString() : null,
        direction1m: d1, direction5m: d5, direction15m: d15,
        change1m: changeOf(bars1m), change5m: changeOf(bars5m), change15m: changeOf(bars15m),
        timeframesKnown: known.length,
        aligned,
        alignedDirection: aligned ? nonFlat[0] : null,
        conflict,
        volatility1m: vol1m,
        volatility15m: vol15m,
        volatilityRatio,
        volatilityExpanding: volatilityRatio === null ? null : volatilityRatio > 1.5,
        // Insufficient history is reported, never silently treated as FLAT.
        complete: known.length === 3,
    };
};
