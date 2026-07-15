import { describe, it, expect } from "vitest";
import {
    computeCalibrationCells,
    claimedProbability,
    decayWeight,
    decisionSuccess,
    stanceSuccess,
    type CalibrationSample,
} from "../calibration.js";

const sample = (overrides: Partial<CalibrationSample> = {}): CalibrationSample => ({
    agentName: "synthesizer",
    agentVersion: "v4.0.0",
    regime: "UP_LOWVOL",
    horizon: "intraday",
    confidence: "HIGH",
    success: true,
    ageDays: 0,
    ...overrides,
});

describe("hand-computed Brier arithmetic", () => {
    it("12 HIGH claims, 9 right: brier 0.1875, hitRate 0.75 (perfectly calibrated)", () => {
        // by hand: 9*(0.75-1)^2 + 3*(0.75-0)^2 = 9*0.0625 + 3*0.5625 = 2.25; /12 = 0.1875
        const samples = [
            ...Array.from({ length: 9 }, () => sample({ success: true })),
            ...Array.from({ length: 3 }, () => sample({ success: false })),
        ];
        const cell = computeCalibrationCells(samples).find((c) => c.regime === "UP_LOWVOL");
        expect(cell).toMatchObject({ n: 12, nEffective: 12, sufficient: true, brier: 0.1875, hitRate: 0.75 });
    });

    it("overconfidence is punished: 12 HIGH claims all wrong -> brier 0.5625", () => {
        const samples = Array.from({ length: 12 }, () => sample({ success: false }));
        const cell = computeCalibrationCells(samples).find((c) => c.regime === "UP_LOWVOL");
        expect(cell).toMatchObject({ brier: 0.5625, hitRate: 0 });
    });
});

describe("recency decay and effective sample size", () => {
    it("weight halves every 90 days, deterministically", () => {
        expect(decayWeight(0)).toBe(1);
        expect(decayWeight(90)).toBe(0.5);
        expect(decayWeight(180)).toBe(0.25);
        expect(decayWeight(45)).toBeGreaterThan(decayWeight(46));
    });

    it("Kish n_eff shrinks below raw n under unequal weights: 10 fresh + 10 stale -> 18", () => {
        // sumW = 10 + 5 = 15; sumW2 = 10 + 2.5 = 12.5; 15^2/12.5 = 18
        const samples = [
            ...Array.from({ length: 10 }, () => sample({ ageDays: 0 })),
            ...Array.from({ length: 10 }, () => sample({ ageDays: 90 })),
        ];
        const cell = computeCalibrationCells(samples).find((c) => c.regime === "UP_LOWVOL");
        expect(cell).toMatchObject({ n: 20, nEffective: 18, sufficient: true });
    });

    it("invalid ages and unknown confidence buckets are errors, not guesses", () => {
        expect(() => decayWeight(-1)).toThrow(/invalid/);
        expect(() => decayWeight(NaN)).toThrow(/invalid/);
        expect(() => claimedProbability("VERY_HIGH")).toThrow(/unknown confidence/);
    });
});

describe("insufficient cells never report a number", () => {
    it("n_eff below 10 -> sufficient false, brier and hitRate null", () => {
        const samples = Array.from({ length: 9 }, () => sample());
        const cell = computeCalibrationCells(samples).find((c) => c.regime === "UP_LOWVOL");
        expect(cell).toMatchObject({ n: 9, nEffective: 9, sufficient: false, brier: null, hitRate: null });
    });

    it("decay can push a raw-sufficient cell under the gate", () => {
        // 12 raw samples but 11 are ancient: n_eff collapses toward ~2
        const samples = [
            sample({ ageDays: 0 }),
            ...Array.from({ length: 11 }, () => sample({ ageDays: 900 })),
        ];
        const cell = computeCalibrationCells(samples).find((c) => c.regime === "UP_LOWVOL");
        expect(cell!.n).toBe(12);
        expect(cell!.sufficient).toBe(false);
        expect(cell!.brier).toBeNull();
    });
});

describe("grouping, rollups and determinism", () => {
    it("cells split by regime with an 'all' rollup that sums them", () => {
        const samples = [
            ...Array.from({ length: 10 }, () => sample({ regime: "UP_LOWVOL" })),
            ...Array.from({ length: 10 }, () => sample({ regime: "DOWN_HIGHVOL", success: false })),
        ];
        const cells = computeCalibrationCells(samples);
        const byRegime = Object.fromEntries(cells.map((c) => [c.regime, c]));
        expect(byRegime.UP_LOWVOL.n).toBe(10);
        expect(byRegime.DOWN_HIGHVOL.n).toBe(10);
        expect(byRegime.all.n).toBe(20);
        expect(byRegime.all.hitRate).toBe(0.5);
    });

    it("input order never changes the output (deterministic replay)", () => {
        const samples = [
            ...Array.from({ length: 15 }, (_, i) => sample({ ageDays: i * 7, success: i % 3 !== 0 })),
            ...Array.from({ length: 15 }, (_, i) => sample({ agentName: "technical", confidence: "LOW", ageDays: i })),
        ];
        const forward = computeCalibrationCells(samples);
        const backward = computeCalibrationCells([...samples].reverse());
        expect(backward).toEqual(forward);
    });
});

describe("success semantics (calibration_v1)", () => {
    it("decision level: targets win, stops lose, drift follows the sign, abstain is unscoreable", () => {
        expect(decisionSuccess({ basis: "path", hit: "target", realizedReturnBps: 80 })).toBe(true);
        expect(decisionSuccess({ basis: "path", hit: "stop", realizedReturnBps: -60 })).toBe(false);
        expect(decisionSuccess({ basis: "close", hit: "neither", realizedReturnBps: 12 })).toBe(true);
        expect(decisionSuccess({ basis: "close", hit: "neither", realizedReturnBps: -12 })).toBe(false);
        expect(decisionSuccess({ basis: "abstain", hit: "neither", realizedReturnBps: null })).toBeNull();
        expect(decisionSuccess({ basis: "close", hit: "neither", realizedReturnBps: null })).toBeNull();
    });

    it("stance level: scored against the market's own direction, not the trade's", () => {
        const buyUp = { basis: "close", realizedReturnBps: 50, decisionAction: "BUY" as const };
        const sellProfit = { basis: "close", realizedReturnBps: 50, decisionAction: "SELL" as const };
        expect(stanceSuccess("BULLISH", buyUp)).toBe(true);
        expect(stanceSuccess("BEARISH", buyUp)).toBe(false);
        // a profitable SELL means the market FELL: bearish was right, bullish wrong
        expect(stanceSuccess("BULLISH", sellProfit)).toBe(false);
        expect(stanceSuccess("BEARISH", sellProfit)).toBe(true);
        expect(stanceSuccess("NEUTRAL", buyUp)).toBeNull();
        expect(stanceSuccess("BULLISH", { basis: "close", realizedReturnBps: 0, decisionAction: "BUY" })).toBeNull();
        expect(stanceSuccess("BULLISH", { basis: "close", realizedReturnBps: null, decisionAction: "BUY" })).toBeNull();
    });
});
