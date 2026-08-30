import { describe, expect, it, vi } from "vitest";
import { ReflexLane, CROSSING, DIRECTION, DEFAULT_WATCH, isProtective }
    from "../services/tick/reflex.js";

// G2. Six per-tick-observable conditions were evaluated every 15 seconds. A
// move that happened and reversed between two samples was invisible. These
// tests pin the continuous behaviour, and pin that it stays deterministic and
// never reaches for a model.

const commitment = (over = {}) => ({
    thesisId: "t-1", direction: DIRECTION.LONG,
    stopPaise: 98_000, targetPaise: 108_000, quantity: 200,
    correlationId: "c-1", ...over,
});

const armedAndWatched = (over = {}, watch = {}) => {
    const lane = new ReflexLane();
    lane.arm("RELIANCE", commitment(over));
    lane.watch("RELIANCE", { entryPaise: 100_000, ...watch });
    return lane;
};

const kinds = (events) => events.map((e) => e.kind);

describe("continuous detection is off unless asked for", () => {
    it("an armed but unwatched symbol behaves exactly as before", () => {
        const lane = new ReflexLane();
        lane.arm("RELIANCE", commitment());
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 99_000 })).toHaveLength(0);
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 105_000 })).toHaveLength(0);
        expect(kinds(lane.onTick({ symbol: "RELIANCE", pricePaise: 97_000 }))).toEqual([CROSSING.STOP]);
    });

    it("an unwatched, unarmed symbol still produces nothing", () => {
        const lane = new ReflexLane();
        expect(lane.onTick({ symbol: "TCS", pricePaise: 50_000 })).toHaveLength(0);
    });
});

describe("approach bands are seen on the tick", () => {
    it("fires when price enters the stop band", () => {
        const lane = armedAndWatched();
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 99_500 })).toHaveLength(0);
        // entry 100000, stop 98000: span 2000. Within 25% means <= 98500.
        const got = lane.onTick({ symbol: "RELIANCE", pricePaise: 98_400 });
        expect(kinds(got)).toContain(CROSSING.STOP_APPROACH);
        expect(got[0].reason).toMatch(/within \d+% of the level/);
    });

    it("fires when price enters the target band", () => {
        const lane = armedAndWatched();
        const got = lane.onTick({ symbol: "RELIANCE", pricePaise: 106_500 });
        expect(kinds(got)).toContain(CROSSING.TARGET_APPROACH);
    });

    it("an approach is not a protective action", () => {
        const lane = armedAndWatched();
        const got = lane.onTick({ symbol: "RELIANCE", pricePaise: 98_400 });
        expect(got[0].protective).toBe(false);
        expect(isProtective(got[0].kind)).toBe(false);
        expect(isProtective(CROSSING.STOP)).toBe(true);
        expect(isProtective(CROSSING.INVALIDATION)).toBe(true);
    });

    it("does not fire once the level itself is breached", () => {
        const lane = armedAndWatched();
        const got = lane.onTick({ symbol: "RELIANCE", pricePaise: 97_000 });
        expect(kinds(got)).toContain(CROSSING.STOP);
        expect(kinds(got)).not.toContain(CROSSING.STOP_APPROACH);
    });

    it("is edge triggered: sitting in the band does not re-fire", () => {
        const lane = armedAndWatched();
        expect(kinds(lane.onTick({ symbol: "RELIANCE", pricePaise: 98_400 })))
            .toContain(CROSSING.STOP_APPROACH);
        for (let i = 0; i < 30; i += 1) {
            expect(kinds(lane.onTick({ symbol: "RELIANCE", pricePaise: 98_300 })))
                .not.toContain(CROSSING.STOP_APPROACH);
        }
    });
});

describe("price velocity is measured over a window, not between poll samples", () => {
    it("sees a 2% move inside the window", () => {
        const lane = new ReflexLane();
        lane.watch("TCS", { jumpPercent: 2.0, velocityWindowMs: 60_000 });
        lane.onTick({ symbol: "TCS", pricePaise: 100_000, at: 0 });
        expect(lane.onTick({ symbol: "TCS", pricePaise: 101_000, at: 10_000 })).toHaveLength(0);
        const got = lane.onTick({ symbol: "TCS", pricePaise: 102_100, at: 20_000 });
        expect(kinds(got)).toContain(CROSSING.PRICE_JUMP);
        expect(got[0].reason).toMatch(/moved 2\.10% within 60s/);
    });

    it("sees a downward move just as readily", () => {
        const lane = new ReflexLane();
        lane.watch("TCS", {});
        lane.onTick({ symbol: "TCS", pricePaise: 100_000, at: 0 });
        expect(kinds(lane.onTick({ symbol: "TCS", pricePaise: 97_000, at: 5_000 })))
            .toContain(CROSSING.PRICE_JUMP);
    });

    it("THE GAP: a spike that reverses between two 15s samples is still seen", () => {
        const lane = new ReflexLane();
        lane.watch("TCS", {});
        // A 15-second poll sampling at t=0 and t=15000 sees 1000 then 1000 and
        // concludes nothing happened.
        lane.onTick({ symbol: "TCS", pricePaise: 100_000, at: 0 });
        const spike = lane.onTick({ symbol: "TCS", pricePaise: 103_500, at: 7_000 });
        lane.onTick({ symbol: "TCS", pricePaise: 100_000, at: 15_000 });
        expect(kinds(spike)).toContain(CROSSING.PRICE_JUMP);
    });

    it("forgets prices that fall out of the window", () => {
        const lane = new ReflexLane();
        lane.watch("TCS", { jumpPercent: 2.0, velocityWindowMs: 30_000 });
        lane.onTick({ symbol: "TCS", pricePaise: 100_000, at: 0 });
        // A drift of the same size spread beyond the window is not a jump.
        expect(lane.onTick({ symbol: "TCS", pricePaise: 102_500, at: 90_000 })).toHaveLength(0);
    });

    it("does not fire below the threshold", () => {
        const lane = new ReflexLane();
        lane.watch("TCS", { jumpPercent: 2.0 });
        lane.onTick({ symbol: "TCS", pricePaise: 100_000, at: 0 });
        expect(lane.onTick({ symbol: "TCS", pricePaise: 101_500, at: 1_000 })).toHaveLength(0);
    });
});

describe("vwap deviation is compared on the tick against a bar-scale value", () => {
    it("fires beyond the deviation bound", () => {
        const lane = new ReflexLane();
        lane.watch("INFY", { vwapDeviation: 0.02 });
        lane.updateVwap("INFY", 100_000);
        expect(lane.onTick({ symbol: "INFY", pricePaise: 101_000 })).toHaveLength(0);
        const got = lane.onTick({ symbol: "INFY", pricePaise: 102_500 });
        expect(kinds(got)).toContain(CROSSING.VWAP_DEVIATION);
        expect(got[0].reason).toMatch(/2\.50% from session VWAP/);
    });

    it("does nothing until a vwap has been supplied", () => {
        const lane = new ReflexLane();
        lane.watch("INFY", {});
        expect(lane.onTick({ symbol: "INFY", pricePaise: 200_000 })).toHaveLength(0);
    });

    it("a new vwap reopens the question", () => {
        const lane = new ReflexLane();
        lane.watch("INFY", {});
        lane.updateVwap("INFY", 100_000);
        expect(kinds(lane.onTick({ symbol: "INFY", pricePaise: 103_000 })))
            .toContain(CROSSING.VWAP_DEVIATION);
        expect(lane.onTick({ symbol: "INFY", pricePaise: 103_100 })).toHaveLength(0);
        lane.updateVwap("INFY", 101_000);
        expect(kinds(lane.onTick({ symbol: "INFY", pricePaise: 104_000 })))
            .toContain(CROSSING.VWAP_DEVIATION);
    });
});

describe("staleness is swept, because absence of ticks cannot arrive as a tick", () => {
    it("reports a watched symbol that has gone quiet", () => {
        // A fixed clock: silence is measured from the later of the last tick
        // and when the watch began, so the watch cannot begin in the future
        // relative to the synthetic tick timestamps below.
        const lane = new ReflexLane({ clock: () => 0 });
        lane.watch("TCS", {});
        lane.onTick({ symbol: "TCS", pricePaise: 100_000, at: 1_000 });
        expect(lane.staleSymbols(50_000, 90_000)).toHaveLength(0);
        const stale = lane.staleSymbols(120_000, 90_000);
        expect(stale).toHaveLength(1);
        expect(stale[0].symbol).toBe("TCS");
        expect(stale[0].ageMs).toBe(119_000);
    });

    it("ignores symbols nobody asked to watch", () => {
        const lane = new ReflexLane({ clock: () => 0 });
        lane.onTick({ symbol: "TCS", pricePaise: 100_000, at: 1_000 });
        expect(lane.staleSymbols(999_000, 90_000)).toHaveLength(0);
    });
});

describe("protection is never displaced by attention signals", () => {
    it("a stop crossing and a signal in the same tick both appear, stop first", () => {
        const lane = armedAndWatched({}, { jumpPercent: 1.0 });
        lane.onTick({ symbol: "RELIANCE", pricePaise: 100_000, at: 0 });
        const got = lane.onTick({ symbol: "RELIANCE", pricePaise: 97_000, at: 1_000 });
        expect(got[0].kind).toBe(CROSSING.STOP);
        expect(kinds(got)).toContain(CROSSING.PRICE_JUMP);
    });

    it("the handler is called for every crossing including signals", () => {
        const onCrossing = vi.fn();
        const lane = new ReflexLane({ onCrossing });
        lane.watch("TCS", {});
        lane.onTick({ symbol: "TCS", pricePaise: 100_000, at: 0 });
        lane.onTick({ symbol: "TCS", pricePaise: 104_000, at: 1_000 });
        expect(onCrossing).toHaveBeenCalled();
        expect(onCrossing.mock.calls.at(-1)[0].kind).toBe(CROSSING.PRICE_JUMP);
    });

    it("a failing handler never breaks the tick loop", () => {
        const lane = new ReflexLane({ onCrossing: () => { throw new Error("down"); } });
        lane.watch("TCS", {});
        lane.onTick({ symbol: "TCS", pricePaise: 100_000, at: 0 });
        expect(() => lane.onTick({ symbol: "TCS", pricePaise: 104_000, at: 1_000 })).not.toThrow();
    });

    it("disarming stops both protection and detection", () => {
        const lane = armedAndWatched();
        lane.disarm("RELIANCE");
        expect(lane.isWatched("RELIANCE")).toBe(false);
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 90_000 })).toHaveLength(0);
    });

    it("detection remains allocation-light and model-free", () => {
        const lane = armedAndWatched({}, { jumpPercent: 50 });
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < 100_000; i += 1) {
            lane.onTick({ symbol: "RELIANCE", pricePaise: 100_000 + (i % 300), at: i * 10 });
        }
        const nsPerTick = Number(process.hrtime.bigint() - t0) / 100_000;
        // Well inside the timing contract of 100us; the point is that continuous
        // detection did not turn the tick path into something expensive.
        expect(nsPerTick).toBeLessThan(10_000);
    });
});

describe("the defaults are conservative", () => {
    it("exposes them for callers to reason about", () => {
        expect(DEFAULT_WATCH.approachFraction).toBe(0.25);
        expect(DEFAULT_WATCH.jumpPercent).toBe(2.0);
        expect(DEFAULT_WATCH.vwapDeviation).toBe(0.02);
    });
});
