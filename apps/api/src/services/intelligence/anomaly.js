import { makeEvent, EVENT_TYPES, SEVERITY } from "../autonomous/events.js";

// Deterministic anomaly detection.
//
// No LLM. Detectors emit EVENTS carrying their evidence; the orchestrator
// decides whether anything is worth reasoning about, and the risk gate decides
// whether anything may be acted on. A detector can never reach execution.
//
// PIT SAFETY: every baseline is built from a lookback window that ENDS BEFORE
// the observation. `baselineFrom` slices strictly before the current bar, so an
// anomaly can never be measured against a baseline containing itself or
// anything after it.

export const DETECTOR_VERSION = "anomaly_v1";

// Thresholds in standard deviations from the trailing baseline, except where
// noted. Chosen to be deliberately conservative: a detector that fires
// constantly trains its consumers to ignore it.
export const THRESHOLDS = {
    priceSigmaWarning: 3,
    priceSigmaCritical: 5,
    volumeRatioWarning: 3,      // multiples of median baseline volume
    volumeRatioCritical: 6,
    volatilityRatioWarning: 2,
    volatilityRatioCritical: 4,
    vwapDeviationWarning: 0.02,  // 2% from session VWAP
    vwapDeviationCritical: 0.04,
    marketWideFraction: 0.6,     // share of symbols moving together
    marketWideMoveWarning: 0.01, // 1% median absolute move
    marketWideMoveCritical: 0.02,
};

export const MIN_BASELINE_SAMPLES = 20;
export const DEFAULT_LOOKBACK = 60;

// The PIT boundary. Everything strictly before `index`, bounded by lookback.
export const baselineFrom = (bars, index, lookback = DEFAULT_LOOKBACK) => {
    if (index <= 0) return [];
    const start = Math.max(0, index - lookback);
    return bars.slice(start, index);
};

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

const stdev = (xs) => {
    if (xs.length < 2) return null;
    const m = mean(xs);
    return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

const median = (xs) => {
    if (!xs.length) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export const returnsOf = (bars) => {
    const out = [];
    for (let i = 1; i < bars.length; i += 1) {
        const prev = bars[i - 1].close, cur = bars[i].close;
        if (Number.isFinite(prev) && Number.isFinite(cur) && prev > 0) out.push((cur - prev) / prev);
    }
    return out;
};

const escalate = (value, warning, critical) => {
    if (Math.abs(value) >= critical) return SEVERITY.CRITICAL;
    if (Math.abs(value) >= warning) return SEVERITY.WARNING;
    return null;
};

// Bucketing turns an evolving condition into ONE event rather than one per
// bar. The bucket is the SEVERITY BAND, not the raw magnitude: at extremes,
// 99 sigma and 101 sigma are the same condition and must coalesce, while an
// escalation from WARNING to CRITICAL is genuinely new and must supersede.
const severityBucket = (severity) => severity.toLowerCase();

const build = ({ type, symbol, severity, reason, observed, asOf, bucket, thesisId, correlationId }) =>
    makeEvent({
        type, symbol, severity, reason,
        observed: { ...observed, detector: DETECTOR_VERSION },
        thesisId: thesisId ?? null,
        correlationId: correlationId ?? `anom-${symbol}`,
        source: "anomaly_engine", observedAt: asOf, bucket,
    });

// --- symbol-level detectors -------------------------------------------------

export const detectPriceAnomaly = ({ bars, index, symbol, asOf, thesisId, correlationId }) => {
    const baseline = baselineFrom(bars, index);
    const rets = returnsOf(baseline);
    if (rets.length < MIN_BASELINE_SAMPLES) return null;      // warm-up

    const sd = stdev(rets);
    if (sd === null || sd === 0) return null;

    const prev = bars[index - 1]?.close, cur = bars[index]?.close;
    if (!Number.isFinite(prev) || !Number.isFinite(cur) || prev <= 0) return null;

    const move = (cur - prev) / prev;
    const sigma = (move - mean(rets)) / sd;
    const severity = escalate(sigma, THRESHOLDS.priceSigmaWarning, THRESHOLDS.priceSigmaCritical);
    if (!severity) return null;

    return build({
        type: EVENT_TYPES.PRICE_JUMP, symbol, severity, asOf, thesisId, correlationId,
        reason: `price moved ${(move * 100).toFixed(2)}% (${sigma.toFixed(1)}σ vs ${rets.length}-bar baseline)`,
        observed: { movePercent: move * 100, sigma, baselineSamples: rets.length,
                    baselineStdev: sd, price: cur },
        bucket: `p${severityBucket(severity)}`,
    });
};

export const detectVolumeAnomaly = ({ bars, index, symbol, asOf, thesisId, correlationId }) => {
    const baseline = baselineFrom(bars, index).map((b) => b.volume).filter(Number.isFinite);
    if (baseline.length < MIN_BASELINE_SAMPLES) return null;

    const typical = median(baseline);
    // A baseline of zero volume tells us nothing; a ratio against it is
    // undefined rather than infinite.
    if (!typical || typical <= 0) return null;

    const current = bars[index]?.volume;
    if (!Number.isFinite(current) || current <= 0) return null;

    const ratio = current / typical;
    const severity = escalate(ratio, THRESHOLDS.volumeRatioWarning, THRESHOLDS.volumeRatioCritical);
    if (!severity) return null;

    return build({
        type: EVENT_TYPES.VOLUME_SPIKE, symbol, severity, asOf, thesisId, correlationId,
        reason: `volume ${ratio.toFixed(1)}x the ${baseline.length}-bar median`,
        observed: { ratio, currentVolume: current, medianVolume: typical,
                    baselineSamples: baseline.length },
        bucket: `v${severityBucket(severity)}`,
    });
};

export const detectVolatilityAnomaly = ({ bars, index, symbol, asOf, thesisId, correlationId }) => {
    const baseline = baselineFrom(bars, index);
    const rets = returnsOf(baseline);
    if (rets.length < MIN_BASELINE_SAMPLES) return null;

    const baselineVol = stdev(rets);
    if (!baselineVol || baselineVol <= 0) return null;

    const recent = returnsOf(bars.slice(Math.max(0, index - 5), index + 1));
    const recentVol = stdev(recent);
    if (recentVol === null) return null;

    const ratio = recentVol / baselineVol;
    const severity = escalate(ratio, THRESHOLDS.volatilityRatioWarning,
                              THRESHOLDS.volatilityRatioCritical);
    if (!severity) return null;

    return build({
        type: EVENT_TYPES.VOLATILITY_EXPANSION, symbol, severity, asOf, thesisId, correlationId,
        reason: `short-horizon volatility ${ratio.toFixed(1)}x baseline`,
        observed: { ratio, recentVolatility: recentVol, baselineVolatility: baselineVol,
                    baselineSamples: rets.length },
        bucket: `x${severityBucket(severity)}`,
    });
};

export const detectVwapDeviation = ({ price, vwap, symbol, asOf, thesisId, correlationId }) => {
    if (vwap === null || vwap === undefined || vwap <= 0) return null;
    if (!Number.isFinite(price)) return null;

    const deviation = (price - vwap) / vwap;
    const severity = escalate(deviation, THRESHOLDS.vwapDeviationWarning,
                              THRESHOLDS.vwapDeviationCritical);
    if (!severity) return null;

    return build({
        type: EVENT_TYPES.TECHNICAL_BREAKDOWN, symbol, severity, asOf, thesisId, correlationId,
        reason: `price ${(deviation * 100).toFixed(2)}% from session VWAP`,
        observed: { deviation, price, vwap },
        bucket: `w${severityBucket(severity)}`,
    });
};

// --- market-wide detector ---------------------------------------------------

// One stock falling 5% is a symbol event. Most of the universe falling
// together is a different fact with different consequences, and conflating
// them would broadcast every symbol move to every agent.
export const detectMarketWideMove = ({ moves, asOf, correlationId }) => {
    const values = Object.values(moves).filter(Number.isFinite);
    if (values.length < 10) return null;                       // too few to generalise

    const down = values.filter((m) => m < 0).length;
    const up = values.filter((m) => m > 0).length;
    const dominant = Math.max(down, up);
    const fraction = dominant / values.length;
    if (fraction < THRESHOLDS.marketWideFraction) return null;  // not synchronised

    const magnitude = median(values.map(Math.abs));
    const severity = escalate(magnitude, THRESHOLDS.marketWideMoveWarning,
                              THRESHOLDS.marketWideMoveCritical);
    if (!severity) return null;

    const direction = down > up ? "down" : "up";
    return build({
        type: EVENT_TYPES.REGIME_CHANGE, symbol: "MARKET", severity, asOf, correlationId,
        reason: `${Math.round(fraction * 100)}% of ${values.length} symbols moving ${direction}, median ${(magnitude * 100).toFixed(2)}%`,
        observed: { fraction, direction, medianAbsMove: magnitude, symbolCount: values.length },
        bucket: `m${direction}${severityBucket(severity)}`,
    });
};

// --- orchestration ----------------------------------------------------------

// Runs every symbol detector for one observation. Order is fixed so repeated
// runs over identical data produce identical event sequences.
export const detectSymbolAnomalies = (input) => {
    const detectors = [
        detectPriceAnomaly, detectVolumeAnomaly, detectVolatilityAnomaly,
    ];
    const events = [];
    for (const detector of detectors) {
        const event = detector(input);
        if (event) events.push(event);
    }
    if (input.vwap !== undefined && input.price !== undefined) {
        const event = detectVwapDeviation(input);
        if (event) events.push(event);
    }
    return events;
};
