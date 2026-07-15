import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { labelDecisionOutcome, HORIZONS_FOR_MODE, type DailyCandle } from "../index.js";

/**
 * Candle times: NSE daily bars at 09:15 IST = 03:45 UTC.
 * Decision day: 2026-07-06 (Monday). Sessions follow on 07,08,09,10.
 */
const DAY = 86_400;
const MON = Math.floor(Date.UTC(2026, 6, 6, 3, 45) / 1000);
const bar = (dayOffset: number, o: number, h: number, l: number, c: number): DailyCandle => ({
    time: MON + dayOffset * DAY,
    open: o,
    high: h,
    low: l,
    close: c,
});

// decision made Monday 10:30 IST (05:00 UTC)
const DECIDED_AT = new Date(Date.UTC(2026, 6, 6, 5, 0)).toISOString();

const buy = (over: Partial<Parameters<typeof labelDecisionOutcome>[0]> = {}) => ({
    action: "BUY" as const,
    mode: "DELIVERY" as const,
    entryMinor: 100_000, // ₹1000
    targetMinor: 105_000, // ₹1050
    stopMinor: 97_000, // ₹970
    createdAt: DECIDED_AT,
    ...over,
});

const H1 = { key: "1d", sessions: 1 };
const H5 = { key: "5d", sessions: 5 };

describe("law 1 — no look-ahead, no same-session misattribution", () => {
    it("a target-touching high on the DECISION session is ignored (it may predate the decision)", () => {
        const candles = [
            bar(0, 1000, 1060, 995, 1005), // Monday: high 1060 > target — CONTAMINATED, must not count
            bar(1, 1005, 1010, 1000, 1008), // Tuesday: quiet
        ];
        const label = labelDecisionOutcome(buy(), H1, candles);
        expect(label).toMatchObject({ ready: true, hit: "neither", basis: "close", exitMinor: 100_800 });
    });

    it("candles BEFORE the decision session are never scanned", () => {
        const candles = [
            bar(-3, 900, 1200, 890, 950), // ancient spike through everything
            bar(1, 1005, 1010, 1000, 1008),
        ];
        expect(labelDecisionOutcome(buy(), H1, candles)).toMatchObject({ hit: "neither" });
    });

    it("not ready until the horizon's post-decision sessions exist", () => {
        expect(labelDecisionOutcome(buy(), H5, [bar(1, 1000, 1010, 990, 1005)])).toMatchObject({
            ready: false,
        });
    });
});

describe("law 2 — deterministic integer math (hand-computed)", () => {
    it("BUY close basis: 1000 -> 1008 = +80 bps", () => {
        const label = labelDecisionOutcome(buy(), H1, [bar(1, 1005, 1010, 1000, 1008)]);
        expect(label).toMatchObject({ realizedReturnBps: 80, entryMinor: 100_000, exitMinor: 100_800 });
    });

    it("SELL sign flips: short from 1000, close 1008 = -80 bps", () => {
        const label = labelDecisionOutcome(
            buy({ action: "SELL", targetMinor: 95_000, stopMinor: 103_000 }),
            H1,
            [bar(1, 1005, 1010, 1000, 1008)],
        );
        expect(label).toMatchObject({ realizedReturnBps: -80 });
    });

    it("bps round half away from zero", () => {
        // exit 100005 -> +0.5 bps -> rounds to 1; exit 99995 -> -0.5 -> -1
        const up = labelDecisionOutcome(buy({ targetMinor: null, stopMinor: null }), H1, [bar(1, 1000, 1001, 999, 1000.05)]);
        const down = labelDecisionOutcome(buy({ targetMinor: null, stopMinor: null }), H1, [bar(1, 1000, 1001, 999, 999.95)]);
        expect(up).toMatchObject({ realizedReturnBps: 1 });
        expect(down).toMatchObject({ realizedReturnBps: -1 });
    });
});

describe("path hits, gaps and ambiguity (laws 4 & 5)", () => {
    it("clean target hit exits at the target level", () => {
        const label = labelDecisionOutcome(buy(), H5, [bar(1, 1010, 1052, 1005, 1049), bar(2, 1049, 1050, 1040, 1045)]);
        expect(label).toMatchObject({ hit: "target", basis: "path", exitMinor: 105_000, sessionsUsed: 1, realizedReturnBps: 500 });
    });

    it("gap-up THROUGH the target fills at the open, not the wish price", () => {
        const label = labelDecisionOutcome(buy(), H5, [bar(1, 1062, 1070, 1055, 1064)]);
        expect(label).toMatchObject({ hit: "target", exitMinor: 106_200, realizedReturnBps: 620 });
    });

    it("gap-down THROUGH the stop fills at the (worse) open", () => {
        const label = labelDecisionOutcome(buy(), H5, [bar(1, 950, 980, 945, 975)]);
        expect(label).toMatchObject({ hit: "stop", exitMinor: 95_000, realizedReturnBps: -500 });
    });

    it("a bar spanning BOTH levels resolves to stop (risk-first)", () => {
        const label = labelDecisionOutcome(buy(), H5, [bar(1, 1000, 1060, 965, 1030)]);
        expect(label).toMatchObject({ hit: "stop", exitMinor: 97_000, realizedReturnBps: -300 });
    });

    it("stop for a SELL is above entry and triggers on the high", () => {
        const label = labelDecisionOutcome(
            buy({ action: "SELL", targetMinor: 95_000, stopMinor: 103_000 }),
            H5,
            [bar(1, 1010, 1035, 1005, 1020)],
        );
        expect(label).toMatchObject({ hit: "stop", exitMinor: 103_000, realizedReturnBps: -300 });
    });
});

describe("intraday square-off and abstentions", () => {
    it("intraday labels at the decision session close, path unknowable from daily bars", () => {
        const label = labelDecisionOutcome(
            buy({ mode: "INTRADAY" }),
            HORIZONS_FOR_MODE.INTRADAY[0]!,
            [bar(0, 1000, 1060, 995, 1012)],
        );
        expect(label).toMatchObject({ ready: true, basis: "squareoff", hit: "neither", exitMinor: 101_200, realizedReturnBps: 120, sessionsUsed: 0 });
    });

    it("abstention (no entry) measures the sat-out market open->close over the horizon", () => {
        const label = labelDecisionOutcome(
            buy({ action: "HOLD", entryMinor: null, targetMinor: null, stopMinor: null }),
            H1,
            [bar(1, 1005, 1010, 1000, 1008)],
        );
        // reference = next session open 1005 -> close 1008 = +29.85 -> 30 bps
        expect(label).toMatchObject({ basis: "abstain", hit: "neither", entryMinor: 100_500, exitMinor: 100_800, realizedReturnBps: 30 });
    });
});

describe("law 3 — truncation invariance (replay years later is identical)", () => {
    it("candles beyond the horizon window never change the label", () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 990, max: 1060 }), // future noise prices
                fc.integer({ min: 1, max: 30 }), // how many extra future bars
                (noise, extra) => {
                    const windowBars = [bar(1, 1010, 1020, 1005, 1015), bar(2, 1015, 1030, 1010, 1025)];
                    const base = labelDecisionOutcome(buy(), { key: "2d", sessions: 2 }, windowBars);
                    const extended = labelDecisionOutcome(buy(), { key: "2d", sessions: 2 }, [
                        ...windowBars,
                        ...Array.from({ length: extra }, (_, i) => bar(3 + i, noise, noise + 50, noise - 50, noise)),
                    ]);
                    expect(extended).toEqual(base);
                },
            ),
            { numRuns: 200 },
        );
    });

    it("candle input order never matters (sorted internally)", () => {
        const candles = [bar(2, 1015, 1030, 1010, 1025), bar(1, 1010, 1020, 1005, 1015)];
        const a = labelDecisionOutcome(buy(), H1, candles);
        const b = labelDecisionOutcome(buy(), H1, [...candles].reverse());
        expect(a).toEqual(b);
    });
});

describe("IST session boundary", () => {
    it("a decision at 23:30 IST belongs to that IST date even though UTC has moved on", () => {
        // 2026-07-06 23:30 IST == 18:00 UTC on the 6th; next session is the 7th
        const lateNight = new Date(Date.UTC(2026, 6, 6, 18, 0)).toISOString();
        const label = labelDecisionOutcome(buy({ createdAt: lateNight }), H1, [
            bar(0, 1000, 1070, 995, 1005), // the 6th: must still be excluded (same IST session)
            bar(1, 1005, 1010, 1000, 1008),
        ]);
        expect(label).toMatchObject({ hit: "neither", exitMinor: 100_800 });
    });
});
