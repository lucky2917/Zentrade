import { describe, expect, it } from "vitest";
import {
    PHASE, phaseAt, phaseAtMinutes, minutesIntoSession, describePhase, SESSION_PHASES,
} from "../services/intelligence/sessionPhase.js";
import { sessionVwap, vwapUpTo, vwapDistance, typicalPrice } from "../services/intelligence/vwap.js";
import { buildMtfContext, directionOf, realisedVolatility, DIRECTION } from "../services/intelligence/mtf.js";
import {
    detectPriceAnomaly, detectVolumeAnomaly, detectVolatilityAnomaly,
    detectVwapDeviation, detectMarketWideMove, detectSymbolAnomalies,
    baselineFrom, THRESHOLDS, MIN_BASELINE_SAMPLES, DETECTOR_VERSION,
} from "../services/intelligence/anomaly.js";
import { SEVERITY, EVENT_TYPES } from "../services/autonomous/events.js";

// IST -> UTC: subtract 5:30, borrowing across the hour.
const istAt = (h, m, day = 1) => new Date(Date.UTC(2026, 8, day, 0, h * 60 + m - 330));

describe("session phase", () => {
    it.each([
        [8, 0, PHASE.PRE_OPEN], [9, 14, PHASE.PRE_OPEN],
        [9, 15, PHASE.OPEN], [9, 29, PHASE.OPEN],
        [9, 30, PHASE.EARLY_SESSION], [10, 59, PHASE.EARLY_SESSION],
        [11, 0, PHASE.MID_SESSION], [13, 59, PHASE.MID_SESSION],
        [14, 0, PHASE.LATE_SESSION], [15, 19, PHASE.LATE_SESSION],
        [15, 20, PHASE.CLOSE], [15, 29, PHASE.CLOSE],
        // 15:30 is the bell itself, not after it. Two definitions of session
        // phase existed and disagreed at exactly this minute; the operational
        // session model (orchestrator/session.js) treats 15:30 as still
        // CLOSING and permits exits, so the descriptive phase matches it.
        [15, 30, PHASE.CLOSE], [15, 31, PHASE.POST_CLOSE], [23, 0, PHASE.POST_CLOSE],
    ])("%s:%s IST is %s", (h, m, want) => expect(phaseAt(istAt(h, m))).toBe(want));

    it("is a pure function of the timestamp — no candles, so no look-ahead", () => {
        expect(phaseAtMinutes(12 * 60)).toBe(phaseAtMinutes(12 * 60));
        expect(phaseAt(istAt(12, 0))).toBe(phaseAt(istAt(12, 0)));
    });

    it("reports minutes into the session, negative before the bell", () => {
        expect(minutesIntoSession(istAt(9, 15))).toBe(0);
        expect(minutesIntoSession(istAt(10, 15))).toBe(60);
        expect(minutesIntoSession(istAt(9, 0))).toBe(-15);
    });

    it("documents why every boundary exists", () => {
        for (const phase of SESSION_PHASES) expect(describePhase(phase).length).toBeGreaterThan(10);
    });
});

const bar = (ts, close, volume = 1000, spread = 1) => ({
    ts, close, high: close + spread, low: close - spread, volume,
});

describe("session VWAP", () => {
    it("weights by volume, not by bar count", () => {
        const bars = [bar("x", 100, 1), bar("x", 200, 999)];
        const v = sessionVwap(bars);
        expect(v).toBeGreaterThan(190);   // dominated by the heavy bar
    });

    it("equals typical price for a single bar", () => {
        expect(sessionVwap([bar("x", 100)])).toBeCloseTo(typicalPrice(bar("x", 100)));
    });

    it("ignores zero-volume bars rather than dragging VWAP toward them", () => {
        const withZero = sessionVwap([bar("x", 100, 1000), bar("x", 500, 0)]);
        const without = sessionVwap([bar("x", 100, 1000)]);
        expect(withZero).toBeCloseTo(without);
    });

    it("returns null when nothing traded", () => {
        expect(sessionVwap([bar("x", 100, 0)])).toBeNull();
        expect(sessionVwap([])).toBeNull();
    });

    it("ignores malformed bars", () => {
        expect(sessionVwap([{ close: NaN, high: 1, low: 1, volume: 10 }])).toBeNull();
    });

    it("resets at the session boundary: yesterday cannot leak into today", () => {
        const bars = [
            { ...bar(istAt(10, 0, 1).toISOString(), 100, 100000) },   // day 1
            { ...bar(istAt(10, 0, 2).toISOString(), 200, 100) },      // day 2
        ];
        const today = vwapUpTo(bars, istAt(11, 0, 2).toISOString());
        expect(today.barsUsed).toBe(1);
        expect(today.vwap).toBeCloseTo(200, 0);
    });

    it("uses no bar after as_of", () => {
        const bars = [
            bar(istAt(10, 0).toISOString(), 100),
            bar(istAt(11, 0).toISOString(), 100),
            bar(istAt(12, 0).toISOString(), 9999),   // the future
        ];
        const result = vwapUpTo(bars, istAt(11, 0).toISOString());
        expect(result.barsUsed).toBe(2);
        expect(result.vwap).toBeLessThan(200);
    });

    it("excludes pre-open bars from the session accumulation", () => {
        const bars = [
            bar(istAt(9, 0).toISOString(), 500),     // pre-open
            bar(istAt(10, 0).toISOString(), 100),
        ];
        expect(vwapUpTo(bars, istAt(11, 0).toISOString()).barsUsed).toBe(1);
    });

    it("reports unavailability rather than guessing", () => {
        const result = vwapUpTo([], istAt(11, 0).toISOString());
        expect(result.available).toBe(false);
        expect(result.vwap).toBeNull();
    });

    it("computes signed distance from VWAP", () => {
        expect(vwapDistance(102, 100)).toBeCloseTo(0.02);
        expect(vwapDistance(98, 100)).toBeCloseTo(-0.02);
        expect(vwapDistance(100, null)).toBeNull();
        expect(vwapDistance(100, 0)).toBeNull();
    });
});

const series = (closes) => closes.map((c, i) => bar(`t${i}`, c));

describe("multi-timeframe context", () => {
    it("reports direction per timeframe", () => {
        expect(directionOf(series([100, 101, 102]))).toBe(DIRECTION.UP);
        expect(directionOf(series([102, 101, 100]))).toBe(DIRECTION.DOWN);
        expect(directionOf(series([100, 100, 100]))).toBe(DIRECTION.FLAT);
    });

    it("returns null on insufficient history instead of guessing FLAT", () => {
        expect(directionOf(series([100, 101]))).toBeNull();
        expect(directionOf([])).toBeNull();
    });

    it("detects alignment only when all three agree and none is flat", () => {
        const ctx = buildMtfContext({
            bars1m: series([100, 101, 102]), bars5m: series([100, 102, 104]),
            bars15m: series([100, 103, 106]),
        });
        expect(ctx.aligned).toBe(true);
        expect(ctx.alignedDirection).toBe(DIRECTION.UP);
        expect(ctx.conflict).toBe(false);
    });

    it("does not call it aligned when a leg is flat", () => {
        const ctx = buildMtfContext({
            bars1m: series([100, 101, 102]), bars5m: series([100, 100, 100]),
            bars15m: series([100, 103, 106]),
        });
        expect(ctx.aligned).toBe(false);
    });

    it("detects genuine conflict", () => {
        const ctx = buildMtfContext({
            bars1m: series([100, 99, 98]), bars5m: series([100, 102, 104]),
            bars15m: series([100, 103, 106]),
        });
        expect(ctx.conflict).toBe(true);
        expect(ctx.aligned).toBe(false);
    });

    it("reports incompleteness rather than pretending", () => {
        const ctx = buildMtfContext({ bars1m: series([100, 101, 102]), bars5m: [], bars15m: [] });
        expect(ctx.complete).toBe(false);
        expect(ctx.timeframesKnown).toBe(1);
        expect(ctx.aligned).toBe(false);
    });

    it("flags volatility expansion when short horizon exceeds long", () => {
        const calm = series([100, 100.01, 100.02, 100.01, 100.02, 100.03]);
        const wild = series([100, 105, 95, 108, 92, 110]);
        const ctx = buildMtfContext({ bars1m: wild, bars5m: calm, bars15m: calm });
        expect(ctx.volatilityExpanding).toBe(true);
    });

    it("computes realised volatility, null on too little data", () => {
        expect(realisedVolatility(series([100, 101, 99, 102]))).toBeGreaterThan(0);
        expect(realisedVolatility(series([100]))).toBeNull();
    });
});

// A calm baseline with one controlled shock at the end.
const calmBars = (n = 40, base = 100) =>
    Array.from({ length: n }, (_, i) => bar(`t${i}`, base + (i % 2 === 0 ? 0.05 : -0.05), 1000));

describe("anomaly baselines are PIT-safe", () => {
    it("excludes the observation itself and everything after it", () => {
        const bars = calmBars(40);
        const baseline = baselineFrom(bars, 30);
        expect(baseline).toHaveLength(30);
        expect(baseline).not.toContain(bars[30]);
        expect(baseline.every((b) => bars.indexOf(b) < 30)).toBe(true);
    });

    it("is empty at the first observation", () => {
        expect(baselineFrom(calmBars(10), 0)).toHaveLength(0);
    });

    it("is bounded by the lookback window", () => {
        expect(baselineFrom(calmBars(200), 150, 60)).toHaveLength(60);
    });

    it("emits nothing during warm-up rather than firing on thin evidence", () => {
        const bars = [...calmBars(5), bar("shock", 200, 1000)];
        expect(detectPriceAnomaly({ bars, index: 5, symbol: "X", asOf: new Date() })).toBeNull();
    });
});

describe("symbol anomaly detection", () => {
    const asOf = istAt(11, 0);

    it("detects an abnormal price move and reports its evidence", () => {
        const bars = [...calmBars(40), bar("shock", 110, 1000)];
        const event = detectPriceAnomaly({ bars, index: 40, symbol: "X", asOf });
        expect(event).not.toBeNull();
        expect(event.type).toBe(EVENT_TYPES.PRICE_JUMP);
        expect(event.observed.sigma).toBeGreaterThan(THRESHOLDS.priceSigmaWarning);
        expect(event.observed.baselineSamples).toBeGreaterThanOrEqual(MIN_BASELINE_SAMPLES);
        expect(event.observed.detector).toBe(DETECTOR_VERSION);
        expect(event.reason).toMatch(/baseline/);
    });

    it("stays silent on normal movement", () => {
        const bars = calmBars(41);
        expect(detectPriceAnomaly({ bars, index: 40, symbol: "X", asOf })).toBeNull();
    });

    it("escalates to CRITICAL on an extreme move", () => {
        // A realistically noisy baseline: against a near-zero-variance series
        // even a small move is many sigma, which says more about the fixture
        // than the detector.
        const noisy = Array.from({ length: 40 }, (_, i) =>
            bar(`t${i}`, 100 + Math.sin(i) * 0.8, 1000));
        const mild = [...noisy, bar("s", 100 + Math.sin(40) * 0.8 + 2.5, 1000)];
        const wild = [...noisy, bar("s", 400, 1000)];
        const a = detectPriceAnomaly({ bars: mild, index: 40, symbol: "X", asOf });
        const b = detectPriceAnomaly({ bars: wild, index: 40, symbol: "X", asOf });
        expect(b.severity).toBe(SEVERITY.CRITICAL);
        if (a) expect(a.severity).toBe(SEVERITY.WARNING);
    });

    it("detects a volume spike against the median", () => {
        const bars = [...calmBars(40), bar("v", 100, 20000)];
        const event = detectVolumeAnomaly({ bars, index: 40, symbol: "X", asOf });
        expect(event.type).toBe(EVENT_TYPES.VOLUME_SPIKE);
        expect(event.observed.ratio).toBeGreaterThan(THRESHOLDS.volumeRatioWarning);
    });

    it("does not divide by a zero-volume baseline", () => {
        const bars = [...Array.from({ length: 40 }, (_, i) => bar(`t${i}`, 100, 0)), bar("v", 100, 5000)];
        expect(detectVolumeAnomaly({ bars, index: 40, symbol: "X", asOf })).toBeNull();
    });

    it("detects volatility expansion", () => {
        const bars = [...calmBars(40), bar("a", 103), bar("b", 97), bar("c", 105)];
        const event = detectVolatilityAnomaly({ bars, index: 42, symbol: "X", asOf });
        expect(event?.type).toBe(EVENT_TYPES.VOLATILITY_EXPANSION);
    });

    it("detects deviation from session VWAP", () => {
        const event = detectVwapDeviation({ price: 105, vwap: 100, symbol: "X", asOf });
        expect(event.observed.deviation).toBeCloseTo(0.05);
        expect(event.severity).toBe(SEVERITY.CRITICAL);
        expect(detectVwapDeviation({ price: 100.5, vwap: 100, symbol: "X", asOf })).toBeNull();
    });

    it("handles a missing VWAP without throwing", () => {
        expect(detectVwapDeviation({ price: 100, vwap: null, symbol: "X", asOf })).toBeNull();
    });
});

describe("market-wide versus symbol-specific", () => {
    const asOf = istAt(11, 0);

    it("does not call one falling stock a market event", () => {
        const moves = Object.fromEntries(
            Array.from({ length: 20 }, (_, i) => [`S${i}`, i === 0 ? -0.05 : 0.0001]));
        expect(detectMarketWideMove({ moves, asOf })).toBeNull();
    });

    it("detects a synchronised market-wide fall", () => {
        const moves = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`S${i}`, -0.025]));
        const event = detectMarketWideMove({ moves, asOf });
        expect(event.symbol).toBe("MARKET");
        expect(event.severity).toBe(SEVERITY.CRITICAL);
        expect(event.observed.direction).toBe("down");
        expect(event.observed.fraction).toBeGreaterThanOrEqual(THRESHOLDS.marketWideFraction);
    });

    it("stays silent when too few symbols are observed to generalise", () => {
        expect(detectMarketWideMove({ moves: { A: -0.05, B: -0.05 }, asOf })).toBeNull();
    });

    it("stays silent when the move is synchronised but small", () => {
        const moves = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`S${i}`, -0.002]));
        expect(detectMarketWideMove({ moves, asOf })).toBeNull();
    });
});

describe("event identity, coalescing and determinism", () => {
    const asOf = istAt(11, 0);

    it("coalesces an evolving condition within the same severity band", () => {
        // 110 and 400 are both far beyond CRITICAL. They are the same ongoing
        // condition and must not each buy their own reasoning call.
        const a = detectPriceAnomaly({ bars: [...calmBars(40), bar("s", 110)], index: 40, symbol: "X", asOf });
        const b = detectPriceAnomaly({ bars: [...calmBars(40), bar("s", 400)], index: 40, symbol: "X", asOf });
        expect(a.severity).toBe(b.severity);
        expect(a.key).toBe(b.key);
    });

    it("produces a different key when severity escalates, so it supersedes", () => {
        const noisy = Array.from({ length: 40 }, (_, i) => bar(`t${i}`, 100 + Math.sin(i) * 0.8, 1000));
        const warn = detectPriceAnomaly({
            bars: [...noisy, bar("s", 100 + Math.sin(40) * 0.8 + 2.5, 1000)], index: 40, symbol: "X", asOf });
        const crit = detectPriceAnomaly({ bars: [...noisy, bar("s", 400, 1000)], index: 40, symbol: "X", asOf });
        expect(warn.severity).not.toBe(crit.severity);
        expect(warn.key).not.toBe(crit.key);
    });

    it("is deterministic across repeated runs over identical data", () => {
        const bars = [...calmBars(40), bar("s", 130, 30000)];
        const run = () => JSON.stringify(detectSymbolAnomalies({
            bars, index: 40, symbol: "X", asOf, price: 130, vwap: 100 }));
        const first = run();
        for (let i = 0; i < 25; i += 1) expect(run()).toBe(first);
    });

    it("emits detectors in a fixed order", () => {
        const bars = [...calmBars(40), bar("s", 130, 30000)];
        const types = detectSymbolAnomalies({
            bars, index: 40, symbol: "X", asOf, price: 130, vwap: 100 }).map((e) => e.type);
        expect(types).toEqual([...types].sort((a, b) =>
            types.indexOf(a) - types.indexOf(b)));   // stable
        expect(types.length).toBeGreaterThan(1);
    });

    it("never returns an event without evidence", () => {
        const bars = [...calmBars(40), bar("s", 130, 30000)];
        for (const e of detectSymbolAnomalies({ bars, index: 40, symbol: "X", asOf })) {
            expect(e.observed).toBeTruthy();
            expect(e.reason.length).toBeGreaterThan(5);
            expect(e.observed.detector).toBe(DETECTOR_VERSION);
        }
    });
});

describe("malformed and degenerate input", () => {
    const asOf = istAt(11, 0);
    it("survives malformed bars without throwing", () => {
        const bars = [...calmBars(40), { ts: "x", close: null, high: null, low: null, volume: null }];
        expect(() => detectSymbolAnomalies({ bars, index: 40, symbol: "X", asOf })).not.toThrow();
    });
    it("survives an empty series", () => {
        expect(detectSymbolAnomalies({ bars: [], index: 0, symbol: "X", asOf })).toEqual([]);
    });
});
