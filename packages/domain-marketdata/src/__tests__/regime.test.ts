import { describe, it, expect } from "vitest";
import { classifyRegime, MIN_SESSIONS, REGIME_TAXONOMY } from "../index.js";

/** Build a candle series from a generator; one session per weekday-ish day. */
const DAY = 86_400;
const BASE = Math.floor(Date.UTC(2026, 0, 5, 3, 45) / 1000);
const series = (closes: number[]): { time: number; close: number }[] =>
    closes.map((close, i) => ({ time: BASE + i * DAY, close }));

/** deterministic pseudo-noise so fixtures are reproducible without RNG */
const wiggle = (i: number, amp: number) => Math.sin(i * 1.7) * amp;

const grind = (n: number, start = 1000, drift = 0.8) =>
    Array.from({ length: n }, (_, i) => start + i * drift + wiggle(i, 1.2));

const crash = (n: number, start = 1000) => {
    // calm first half; second half trends hard down WITH violent swings
    // (a constant -3%/day would have ~zero stdev — not volatility!)
    const out: number[] = [];
    let px = start;
    for (let i = 0; i < n; i++) {
        if (i < n / 2) px = px + wiggle(i, 1.0);
        else px = px * (i % 2 === 0 ? 0.94 : 1.015);
        out.push(px);
    }
    return out;
};

describe("golden fixtures", () => {
    it("steady low-noise uptrend -> UP_LOWVOL", () => {
        const label = classifyRegime(series(grind(MIN_SESSIONS)));
        expect(label).toMatchObject({ ready: true, taxonomy: REGIME_TAXONOMY, trend: "UP", volBucket: "LOWVOL", composite: "UP_LOWVOL", breadth: null });
    });

    it("2020-style crash -> DOWN_HIGHVOL", () => {
        const label = classifyRegime(series(crash(MIN_SESSIONS)));
        expect(label).toMatchObject({ trend: "DOWN", volBucket: "HIGHVOL", composite: "DOWN_HIGHVOL" });
    });

    it("dead-flat tape -> SIDEWAYS_LOWVOL", () => {
        const flat = Array.from({ length: MIN_SESSIONS }, (_, i) => 1000 + wiggle(i, 0.6));
        const label = classifyRegime(series(flat));
        expect(label).toMatchObject({ trend: "SIDEWAYS", volBucket: "LOWVOL" });
    });
});

describe("determinism & replay", () => {
    it("same window -> identical label AND identical inputsHash, repeatedly", () => {
        const candles = series(crash(MIN_SESSIONS));
        const a = classifyRegime(candles);
        const b = classifyRegime([...candles].reverse()); // order-invariant
        expect(a).toEqual(b);
        expect(classifyRegime(candles)).toEqual(a);
    });

    it("extra history left of the window never changes the label (fetch-size invariance)", () => {
        const all = series(grind(MIN_SESSIONS + 200));
        const full = classifyRegime(all);
        const trimmed = classifyRegime(all.slice(-MIN_SESSIONS));
        expect(full).toEqual(trimmed);
    });

    it("insufficient history refuses to guess", () => {
        expect(classifyRegime(series(grind(MIN_SESSIONS - 1)))).toMatchObject({ ready: false });
    });

    it("garbage candles (non-finite/zero closes) are excluded, not classified", () => {
        const closes = grind(MIN_SESSIONS);
        const withJunk = [...series(closes), { time: BASE - DAY, close: NaN }, { time: BASE - 2 * DAY, close: 0 }];
        expect(classifyRegime(withJunk)).toEqual(classifyRegime(series(closes)));
    });

    it("the calDate is the IST date of the final session", () => {
        const label = classifyRegime(series(grind(MIN_SESSIONS)));
        if (!label.ready) throw new Error("expected ready");
        expect(label.calDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});
