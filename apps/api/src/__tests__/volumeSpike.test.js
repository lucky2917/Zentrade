import { describe, expect, it } from "vitest";
import { ReflexLane, CROSSING, DIRECTION } from "../services/tick/reflex.js";
import { AutonomousRuntime } from "../services/autonomous/runtime.js";
import { buildObservation } from "../services/intelligence/observe.js";
import { detectVolumeAnomaly, volumeBaselineOf, THRESHOLDS,
         MIN_BASELINE_SAMPLES } from "../services/intelligence/anomaly.js";

// The last of the six per-tick-observable conditions that was still found only
// by the fifteen-second sweep. A minute's worth of volume arriving in ten
// seconds is visible on the tick that delivers it; waiting for the bar to close
// reports it up to a minute late.

const SYMBOL = "RELIANCE";
const BASELINE = 1_000;
const RATIO = THRESHOLDS.volumeRatioWarning;
const MINUTE = 60_000;

const lane = () => {
    const l = new ReflexLane({ clock: () => 0 });
    l.watch(SYMBOL, { entryPaise: 10_000 });
    l.updateVolumeBaseline(SYMBOL, { baseline: BASELINE, ratio: RATIO });
    return l;
};

const tick = (l, at, cumulativeVolume) =>
    l.onTick({ symbol: SYMBOL, pricePaise: 10_000, at, cumulativeVolume });

describe("tick-path volume spike", () => {
    it("stays silent until a baseline is pushed from the bar path", () => {
        const l = new ReflexLane({ clock: () => 0 });
        l.watch(SYMBOL, { entryPaise: 10_000 });
        tick(l, MINUTE, 1_000_000);
        expect(tick(l, MINUTE + 1_000, 9_999_999)).toEqual([]);
    });

    it("fires when the minute in progress exceeds the typical minute", () => {
        const l = lane();
        tick(l, MINUTE, 500_000);
        const signals = tick(l, MINUTE + 8_000, 500_000 + BASELINE * RATIO);

        expect(signals).toHaveLength(1);
        expect(signals[0].kind).toBe(CROSSING.VOLUME_SPIKE);
        expect(signals[0].protective).toBe(false);
        expect(signals[0].reason).toContain("typical minute volume");
    });

    // Anchoring on the first tick is what makes this measure the minute rather
    // than the session: the feed reports volume cumulatively since the open.
    it("cannot fire on the first tick of a minute", () => {
        const l = lane();
        expect(tick(l, MINUTE, 500_000_000)).toEqual([]);
    });

    it("stays below the threshold for ordinary volume", () => {
        const l = lane();
        tick(l, MINUTE, 500_000);
        expect(tick(l, MINUTE + 30_000, 500_000 + BASELINE)).toEqual([]);
        expect(tick(l, MINUTE + 50_000, 500_000 + BASELINE * 2)).toEqual([]);
    });

    it("reports one spike per minute, not one per tick", () => {
        const l = lane();
        tick(l, MINUTE, 500_000);
        expect(tick(l, MINUTE + 5_000, 500_000 + BASELINE * RATIO)).toHaveLength(1);
        for (let i = 1; i <= 10; i += 1) {
            expect(tick(l, MINUTE + 5_000 + i * 1_000, 500_000 + BASELINE * (RATIO + i))).toEqual([]);
        }
    });

    it("asks the question again in the next minute", () => {
        const l = lane();
        tick(l, MINUTE, 500_000);
        expect(tick(l, MINUTE + 5_000, 500_000 + BASELINE * RATIO)).toHaveLength(1);

        const next = 2 * MINUTE;
        tick(l, next, 600_000);
        expect(tick(l, next + 5_000, 600_000 + BASELINE * RATIO)).toHaveLength(1);
    });

    // A reconnect replays the session from a lower cumulative figure. Treating
    // the difference as volume would report a negative, and re-crossing the
    // old anchor would report a spike that never happened.
    it("re-anchors when the cumulative counter goes backwards", () => {
        const l = lane();
        tick(l, MINUTE, 900_000);
        tick(l, MINUTE + 1_000, 100);
        expect(tick(l, MINUTE + 2_000, 200)).toEqual([]);
        expect(tick(l, MINUTE + 3_000, 100 + BASELINE * RATIO)).toHaveLength(1);
    });

    it("ignores ticks that carry no volume at all", () => {
        const l = lane();
        expect(l.onTick({ symbol: SYMBOL, pricePaise: 10_000, at: MINUTE })).toEqual([]);
        expect(l.onTick({ symbol: SYMBOL, pricePaise: 10_000, at: MINUTE + 1_000 })).toEqual([]);
    });

    it("does not authorise a protective action", () => {
        const l = new ReflexLane({ clock: () => 0 });
        l.arm(SYMBOL, { thesisId: 1, direction: DIRECTION.LONG, stopPaise: 9_000, quantity: 5 });
        l.watch(SYMBOL, { entryPaise: 10_000 });
        l.updateVolumeBaseline(SYMBOL, { baseline: BASELINE, ratio: RATIO });

        tick(l, MINUTE, 500_000);
        const signals = tick(l, MINUTE + 5_000, 500_000 + BASELINE * RATIO);
        expect(signals.map((s) => s.kind)).toEqual([CROSSING.VOLUME_SPIKE]);
        expect(signals[0].thesisId).toBe(1);
    });
});

describe("one definition of typical volume", () => {
    const bars = Array.from({ length: MIN_BASELINE_SAMPLES + 5 }, (_, i) => ({
        ts: new Date(Date.UTC(2026, 7, 31, 4, i)).toISOString(),
        open: 100, high: 101, low: 99, close: 100, volume: BASELINE,
    }));

    it("exposes the same baseline the bar detector uses", () => {
        const measured = volumeBaselineOf(bars, bars.length);
        expect(measured.typical).toBe(BASELINE);

        const context = buildObservation({
            symbol: SYMBOL, bars1m: bars, price: 100,
            asOf: new Date(Date.UTC(2026, 7, 31, 5, 0)),
        });
        expect(context.volumeBaseline).toBe(measured.typical);
        expect(context.volumeBaselineSamples).toBe(measured.samples);
    });

    it("reports no baseline before there is enough history", () => {
        const context = buildObservation({
            symbol: SYMBOL, bars1m: bars.slice(0, MIN_BASELINE_SAMPLES - 1), price: 100,
            asOf: new Date(Date.UTC(2026, 7, 31, 5, 0)),
        });
        expect(context.volumeBaseline).toBeNull();
    });

    it("the bar detector still fires on the same rule", () => {
        const spiked = [...bars, { ...bars[0], volume: BASELINE * (RATIO + 1) }];
        const event = detectVolumeAnomaly({
            bars: spiked, index: spiked.length - 1, symbol: SYMBOL,
            asOf: new Date(Date.UTC(2026, 7, 31, 5, 0)).toISOString(),
            thesisId: null, correlationId: null,
        });
        expect(event.type).toBe("VOLUME_SPIKE");
        expect(event.observed.medianVolume).toBe(BASELINE);
    });
});

describe("runtime baseline sync", () => {
    const buildRuntime = () => new AutonomousRuntime({
        engine: {}, reconciler: null, ports: {},
    });

    it("pushes both baselines only for watched symbols", () => {
        const runtime = buildRuntime();
        runtime.reflex.watch(SYMBOL, { entryPaise: 10_000 });

        const pushed = runtime.syncBaselines({
            [SYMBOL]: { vwap: 101.5, vwapAvailable: true, volumeBaseline: BASELINE },
            IGNORED: { vwap: 50, vwapAvailable: true, volumeBaseline: 20 },
        });

        expect(pushed).toEqual({ vwap: 1, volume: 1 });
        const watch = runtime.reflex.watches.get(SYMBOL);
        expect(watch.vwapPaise).toBe(10_150);
        expect(watch.volumeBaseline).toBe(BASELINE);
        expect(watch.volumeSpikeRatio).toBe(RATIO);
    });

    it("leaves the volume detector off when there is no baseline yet", () => {
        const runtime = buildRuntime();
        runtime.reflex.watch(SYMBOL, { entryPaise: 10_000 });
        const pushed = runtime.syncBaselines({
            [SYMBOL]: { vwap: 101.5, vwapAvailable: true, volumeBaseline: null },
        });
        expect(pushed).toEqual({ vwap: 1, volume: 0 });
        expect(runtime.reflex.watches.get(SYMBOL).volumeSpikeRatio).toBeNull();
    });

    it("carries the tick's cumulative volume through to the lane", () => {
        const runtime = buildRuntime();
        runtime.reflex.watch(SYMBOL, { entryPaise: 10_000 });
        runtime.reflex.updateVolumeBaseline(SYMBOL, { baseline: BASELINE, ratio: RATIO });

        runtime.ingestTick({ symbol: SYMBOL, price: 100, timestamp: MINUTE, volume: 500_000 });
        const signals = runtime.ingestTick({
            symbol: SYMBOL, price: 100, timestamp: MINUTE + 5_000,
            volume: 500_000 + BASELINE * RATIO,
        });
        expect(signals.map((s) => s.kind)).toEqual([CROSSING.VOLUME_SPIKE]);
    });

    it("raises a VOLUME_SPIKE event rather than selling", async () => {
        const recorded = [];
        const executed = [];
        const runtime = new AutonomousRuntime({
            engine: {}, reconciler: null,
            ports: { recordEvent: async (e) => { recorded.push(e); return { id: 1 }; } },
        });
        runtime.executeIntent = async (i) => { executed.push(i); };
        runtime.reflex.watch(SYMBOL, { entryPaise: 10_000, thesisId: 9 });
        runtime.reflex.updateVolumeBaseline(SYMBOL, { baseline: BASELINE, ratio: RATIO });

        runtime.ingestTick({ symbol: SYMBOL, price: 100, timestamp: MINUTE, volume: 500_000 });
        runtime.ingestTick({ symbol: SYMBOL, price: 100, timestamp: MINUTE + 5_000,
                             volume: 500_000 + BASELINE * RATIO });
        await new Promise((r) => setImmediate(r));

        expect(executed).toEqual([]);
        expect(recorded.map((e) => e.type)).toEqual(["VOLUME_SPIKE"]);
        expect(runtime.metrics.materialSignals).toBe(1);
        expect(runtime.metrics.protectiveActions).toBe(0);
    });
});
