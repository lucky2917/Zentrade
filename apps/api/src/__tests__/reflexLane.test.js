import { describe, expect, it, vi } from "vitest";
import { ReflexLane, CROSSING, DIRECTION } from "../services/tick/reflex.js";

const commitment = (over = {}) => ({
    thesisId: "t-1", direction: DIRECTION.LONG,
    stopPaise: 98_000, targetPaise: 108_000, quantity: 200,
    correlationId: "c-1", ...over,
});

describe("the reflex lane reacts on the tick that crosses, not on a poll", () => {
    it("does nothing while price is inside the levels", () => {
        const lane = new ReflexLane();
        lane.arm("RELIANCE", commitment());
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 98_100 })).toHaveLength(0);
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 98_050 })).toHaveLength(0);
    });

    it("fires on the exact tick that breaches the stop", () => {
        const lane = new ReflexLane();
        lane.arm("RELIANCE", commitment());
        lane.onTick({ symbol: "RELIANCE", pricePaise: 98_100 });
        const crossings = lane.onTick({ symbol: "RELIANCE", pricePaise: 97_990 });
        expect(crossings).toHaveLength(1);
        expect(crossings[0].kind).toBe(CROSSING.STOP);
        expect(crossings[0].pricePaise).toBe(97_990);
        expect(crossings[0].quantity).toBe(200);
    });

    it("treats touching the level as breaching it", () => {
        const lane = new ReflexLane();
        lane.arm("RELIANCE", commitment());
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 98_000 })[0].kind).toBe(CROSSING.STOP);
    });

    it("is edge triggered: sitting past the stop does not re-fire every tick", () => {
        const lane = new ReflexLane();
        lane.arm("RELIANCE", commitment());
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 97_900 })).toHaveLength(1);
        for (let i = 0; i < 50; i += 1) {
            expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 97_800 - i })).toHaveLength(0);
        }
        expect(lane.health().suppressed).toBe(50);
    });

    it("fires on the target as well", () => {
        const lane = new ReflexLane();
        lane.arm("RELIANCE", commitment());
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 108_500 })[0].kind).toBe(CROSSING.TARGET);
    });

    it("mirrors the levels for a short", () => {
        const lane = new ReflexLane();
        lane.arm("RELIANCE", commitment({
            direction: DIRECTION.SHORT, stopPaise: 102_000, targetPaise: 92_000 }));
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 101_000 })).toHaveLength(0);
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 102_500 })[0].kind).toBe(CROSSING.STOP);
    });

    it("fires a separate crossing for a named invalidation price", () => {
        const lane = new ReflexLane();
        lane.arm("RELIANCE", commitment({ stopPaise: null, invalidationPaise: 97_000 }));
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 96_900 })[0].kind)
            .toBe(CROSSING.INVALIDATION);
    });

    it("ignores a symbol it was never armed for", () => {
        const lane = new ReflexLane();
        expect(lane.onTick({ symbol: "TCS", pricePaise: 1 })).toHaveLength(0);
    });

    it("stops firing once disarmed", () => {
        const lane = new ReflexLane();
        lane.arm("RELIANCE", commitment());
        lane.disarm("RELIANCE");
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 90_000 })).toHaveLength(0);
    });

    it("re-arming a symbol resets the latch, so a revised thesis is protected", () => {
        const lane = new ReflexLane();
        lane.arm("RELIANCE", commitment());
        lane.onTick({ symbol: "RELIANCE", pricePaise: 97_000 });
        lane.arm("RELIANCE", commitment({ stopPaise: 96_000 }));
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 95_900 })[0].kind).toBe(CROSSING.STOP);
    });

    it("refuses to arm a commitment with no levels at all", () => {
        const lane = new ReflexLane();
        expect(lane.arm("RELIANCE", { thesisId: "t" })).toBe(false);
    });
});

describe("intra-interval extremes cannot disappear", () => {
    it("remembers a spike that happened and retraced between evaluations", () => {
        const lane = new ReflexLane();
        // A 15-second poll sampling only the endpoints would see 1000 then 1000
        // and conclude nothing happened.
        for (const p of [100_000, 103_400, 99_100, 100_000]) {
            lane.onTick({ symbol: "RELIANCE", pricePaise: p });
        }
        const range = lane.takeRange("RELIANCE");
        expect(range.high).toBe(103_400);
        expect(range.low).toBe(99_100);
        expect(range.last).toBe(100_000);
        expect(range.seq).toBe(4);
    });

    it("a transient breach still fires even though price recovered", () => {
        const lane = new ReflexLane();
        lane.arm("RELIANCE", commitment());
        lane.onTick({ symbol: "RELIANCE", pricePaise: 100_000 });
        const fired = lane.onTick({ symbol: "RELIANCE", pricePaise: 97_800 });  // spike through
        lane.onTick({ symbol: "RELIANCE", pricePaise: 100_200 });               // and back
        expect(fired).toHaveLength(1);
    });

    it("taking the range resets the window without losing the last price", () => {
        const lane = new ReflexLane();
        lane.onTick({ symbol: "RELIANCE", pricePaise: 100_000 });
        lane.onTick({ symbol: "RELIANCE", pricePaise: 105_000 });
        lane.takeRange("RELIANCE");
        const after = lane.snapshot("RELIANCE");
        expect(after.high).toBe(105_000);   // the window restarts at the last price
        expect(after.low).toBe(105_000);
    });
});

describe("the protective action is dispatched without the tick loop waiting", () => {
    it("calls the handler synchronously on the crossing tick", () => {
        const onCrossing = vi.fn();
        const lane = new ReflexLane({ onCrossing });
        lane.arm("RELIANCE", commitment());
        lane.onTick({ symbol: "RELIANCE", pricePaise: 97_000 });
        expect(onCrossing).toHaveBeenCalledOnce();
        expect(onCrossing.mock.calls[0][0].kind).toBe(CROSSING.STOP);
    });

    it("a failing protective action never breaks the tick loop", () => {
        const lane = new ReflexLane({ onCrossing: () => { throw new Error("db down"); } });
        lane.arm("RELIANCE", commitment());
        expect(() => lane.onTick({ symbol: "RELIANCE", pricePaise: 97_000 })).not.toThrow();
        expect(() => lane.onTick({ symbol: "TCS", pricePaise: 100 })).not.toThrow();
    });

    it("a rejected promise from the handler is absorbed", async () => {
        const lane = new ReflexLane({ onCrossing: async () => { throw new Error("venue down"); } });
        lane.arm("RELIANCE", commitment());
        lane.onTick({ symbol: "RELIANCE", pricePaise: 97_000 });
        await new Promise((r) => setTimeout(r, 10));   // no unhandled rejection
    });
});
