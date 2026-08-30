import { describe, expect, it } from "vitest";
import { ReflexLane, DIRECTION, DEFAULT_STALE_AFTER_MS } from "../services/tick/reflex.js";
import { AutonomousRuntime } from "../services/autonomous/runtime.js";

// Absence of ticks is the one material condition that cannot arrive as a tick.
// Before this it was found only by the 15-second supervisory monitor, which
// meant the reflex lane could go blind on an armed position and nothing in the
// system noticed that protection had stopped working.

const SYMBOL = "RELIANCE";

// The sweep runs once a second for the whole session. Driving it at its real
// cadence is what the runtime does, and the runtime distinguishes "silent" from
// "the sweep was not running" by that cadence.
const sweepFor = async (runtime, advance, ms, step = 1_000) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
        advance(step);
        await runtime.staleSweep();
    }
};

const laneAt = (nowMs) => {
    let now = nowMs;
    const lane = new ReflexLane({ clock: () => now });
    return { lane, advance: (ms) => { now += ms; }, at: () => now };
};

describe("ReflexLane staleness", () => {
    it("reports nothing while ticks keep arriving", () => {
        const { lane, advance, at } = laneAt(1_000_000);
        lane.watch(SYMBOL, { entryPaise: 10_000 });
        for (let i = 0; i < 10; i += 1) {
            advance(5_000);
            lane.onTick({ symbol: SYMBOL, pricePaise: 10_000, at: at() });
        }
        expect(lane.staleSymbols(at())).toEqual([]);
    });

    it("reports a watched symbol that stops ticking", () => {
        const { lane, advance, at } = laneAt(1_000_000);
        lane.watch(SYMBOL, { entryPaise: 10_000 });
        lane.onTick({ symbol: SYMBOL, pricePaise: 10_000, at: at() });

        advance(DEFAULT_STALE_AFTER_MS + 1);
        const stale = lane.staleSymbols(at());
        expect(stale).toHaveLength(1);
        expect(stale[0].symbol).toBe(SYMBOL);
        expect(stale[0].ticked).toBe(true);
        expect(stale[0].lastPaise).toBe(10_000);
        expect(stale[0].armed).toBe(false);
    });

    // The hole this closes: a position armed at boot on a symbol the feed never
    // delivers has no `state` entry, so measuring from the last tick found
    // nothing to measure and the symbol looked healthy forever.
    it("reports a symbol that has never ticked at all", () => {
        const { lane, advance, at } = laneAt(1_000_000);
        lane.watch(SYMBOL, { entryPaise: 10_000 });

        advance(DEFAULT_STALE_AFTER_MS + 1);
        const stale = lane.staleSymbols(at());
        expect(stale).toHaveLength(1);
        expect(stale[0].ticked).toBe(false);
        expect(stale[0].lastPaise).toBeNull();
    });

    it("marks an armed symbol so a blind stop is not reported like a watchlist name", () => {
        const { lane, advance, at } = laneAt(1_000_000);
        lane.arm(SYMBOL, { thesisId: 7, direction: DIRECTION.LONG, stopPaise: 9_500, quantity: 10 });
        lane.watch(SYMBOL, { entryPaise: 10_000 });
        lane.onTick({ symbol: SYMBOL, pricePaise: 10_000, at: at() });

        advance(DEFAULT_STALE_AFTER_MS + 1);
        expect(lane.staleSymbols(at())[0].armed).toBe(true);
    });

    it("ignores a symbol that is tracked but not watched", () => {
        const { lane, advance, at } = laneAt(1_000_000);
        lane.onTick({ symbol: SYMBOL, pricePaise: 10_000, at: at() });
        advance(DEFAULT_STALE_AFTER_MS + 1);
        expect(lane.staleSymbols(at())).toEqual([]);
    });

    it("is edge triggered: one report per episode, not one per sweep", () => {
        const { lane, advance, at } = laneAt(1_000_000);
        lane.watch(SYMBOL, { entryPaise: 10_000 });
        lane.onTick({ symbol: SYMBOL, pricePaise: 10_000, at: at() });

        advance(DEFAULT_STALE_AFTER_MS + 1);
        expect(lane.newlyStale(at())).toHaveLength(1);
        for (let i = 0; i < 20; i += 1) {
            advance(1_000);
            expect(lane.newlyStale(at())).toEqual([]);
        }
        expect(lane.health().stale).toBe(1);
    });

    it("re-arms the report after the feed recovers and dies again", () => {
        const { lane, advance, at } = laneAt(1_000_000);
        lane.watch(SYMBOL, { entryPaise: 10_000 });
        lane.onTick({ symbol: SYMBOL, pricePaise: 10_000, at: at() });

        advance(DEFAULT_STALE_AFTER_MS + 1);
        expect(lane.newlyStale(at())).toHaveLength(1);

        advance(1_000);
        lane.onTick({ symbol: SYMBOL, pricePaise: 10_100, at: at() });
        expect(lane.health().recovered).toBe(1);
        expect(lane.newlyStale(at())).toEqual([]);

        advance(DEFAULT_STALE_AFTER_MS + 1);
        expect(lane.newlyStale(at())).toHaveLength(1);
        expect(lane.health().stale).toBe(2);
    });

    it("forgets a symbol once the position is closed", () => {
        const { lane, advance, at } = laneAt(1_000_000);
        lane.arm(SYMBOL, { thesisId: 7, stopPaise: 9_500, quantity: 10 });
        lane.watch(SYMBOL, { entryPaise: 10_000 });
        lane.onTick({ symbol: SYMBOL, pricePaise: 10_000, at: at() });
        lane.disarm(SYMBOL);

        advance(DEFAULT_STALE_AFTER_MS + 1);
        expect(lane.staleSymbols(at())).toEqual([]);
        expect(lane.health().staleSymbols).toBe(0);
    });

    it("does not reset the silence clock when a watch is refreshed", () => {
        const { lane, advance, at } = laneAt(1_000_000);
        lane.watch(SYMBOL, { entryPaise: 10_000 });
        advance(DEFAULT_STALE_AFTER_MS - 1_000);
        lane.watch(SYMBOL, { thesisId: 3 });
        advance(2_000);
        expect(lane.staleSymbols(at())).toHaveLength(1);
    });
});

describe("runtime stale sweep", () => {
    const buildRuntime = ({ recorded, nowMs = 1_000_000 }) => {
        const clockRef = { now: nowMs };
        const runtime = new AutonomousRuntime({
            engine: {}, reconciler: null,
            clock: () => new Date(clockRef.now),
            ports: {
                recordEvent: async (event) => { recorded.push(event); return { id: recorded.length }; },
            },
        });
        return { runtime, advance: (ms) => { clockRef.now += ms; } };
    };

    it("raises one CRITICAL event when an armed symbol goes blind", async () => {
        const recorded = [];
        const { runtime, advance } = buildRuntime({ recorded });
        runtime.reflex.arm(SYMBOL, { thesisId: 42, stopPaise: 9_500, quantity: 10,
                                     correlationId: "corr-1" });
        runtime.reflex.watch(SYMBOL, { entryPaise: 10_000 });
        runtime.ingestTick({ symbol: SYMBOL, price: 100 });
        await runtime.staleSweep();          // the session's first sweep
        await sweepFor(runtime, advance, DEFAULT_STALE_AFTER_MS + 2_000);

        expect(recorded).toHaveLength(1);
        expect(recorded[0].type).toBe("DATA_STALE");
        expect(recorded[0].severity).toBe("CRITICAL");
        expect(recorded[0].symbol).toBe(SYMBOL);
        expect(recorded[0].thesisId).toBe(42);
        expect(recorded[0].observed.armed).toBe(true);
        expect(runtime.metrics.blindSymbols).toBe(1);
    });

    it("raises WARNING for a watched symbol with no position", async () => {
        const recorded = [];
        const { runtime, advance } = buildRuntime({ recorded });
        runtime.reflex.watch(SYMBOL, { entryPaise: 10_000 });
        runtime.ingestTick({ symbol: SYMBOL, price: 100 });
        await runtime.staleSweep();
        await sweepFor(runtime, advance, DEFAULT_STALE_AFTER_MS + 2_000);

        expect(recorded).toHaveLength(1);
        expect(recorded[0].severity).toBe("WARNING");
        expect(runtime.metrics.blindSymbols).toBe(0);
    });

    // The sweep runs once a second for the whole session. If it emitted while
    // the feed was healthy it would be the noisiest thing in the system.
    it("costs nothing while the feed is healthy", async () => {
        const recorded = [];
        const { runtime, advance } = buildRuntime({ recorded });
        runtime.reflex.watch(SYMBOL, { entryPaise: 10_000 });
        for (let i = 0; i < 60; i += 1) {
            advance(1_000);
            runtime.ingestTick({ symbol: SYMBOL, price: 100 });
            await runtime.staleSweep();
        }
        expect(recorded).toEqual([]);
        expect(runtime.metrics.staleSweeps).toBe(60);
    });

    it("never trades on the absence of data", async () => {
        const recorded = [];
        const executed = [];
        const { runtime, advance } = buildRuntime({ recorded });
        runtime.executeIntent = async (intent) => { executed.push(intent); };
        runtime.reflex.arm(SYMBOL, { thesisId: 42, stopPaise: 9_500, quantity: 10 });
        runtime.reflex.watch(SYMBOL, { entryPaise: 10_000 });
        runtime.ingestTick({ symbol: SYMBOL, price: 100 });
        await runtime.staleSweep();
        await sweepFor(runtime, advance, DEFAULT_STALE_AFTER_MS + 2_000);

        expect(executed).toEqual([]);
        expect(runtime.metrics.protectiveExits).toBe(0);
    });

    it("survives a recordEvent failure without stopping the sweep", async () => {
        const clockRef = { now: 1_000_000 };
        const runtime = new AutonomousRuntime({
            engine: {}, reconciler: null,
            clock: () => new Date(clockRef.now),
            ports: { recordEvent: async () => { throw new Error("db down"); } },
        });
        runtime.reflex.watch("A", { entryPaise: 100 });
        runtime.reflex.watch("B", { entryPaise: 100 });
        await runtime.staleSweep();

        const reported = [];
        for (let i = 0; i <= DEFAULT_STALE_AFTER_MS / 1_000 + 1; i += 1) {
            clockRef.now += 1_000;
            reported.push(await runtime.staleSweep());
        }
        // Both symbols were reported despite every write failing, and no sweep
        // threw on the way.
        expect(reported.reduce((n, r) => n + r.stale, 0)).toBe(2);
    });

    it("registers the sweep on the scheduler and gates it to the session", () => {
        const runtime = new AutonomousRuntime({ engine: {}, reconciler: null, ports: {} });
        const job = runtime.orchestrator.scheduler.jobs.get("stale-sweep");
        expect(job).toBeTruthy();
        expect(job.intervalMs).toBe(1_000);
    });
});

// The sweep only runs while an exit is possible, so it starts at 09:15 having
// watched nothing. Every position armed during boot has then been silent for
// as long as the machine has been up, and measuring that silence would report
// the whole book blind on the first sweep of the session.
describe("resuming the sweep", () => {
    const buildRuntime = (recorded) => {
        const clockRef = { now: 1_000_000 };
        const runtime = new AutonomousRuntime({
            engine: {}, reconciler: null,
            clock: () => new Date(clockRef.now),
            ports: { recordEvent: async (e) => { recorded.push(e); return { id: 1 }; } },
        });
        return { runtime, advance: (ms) => { clockRef.now += ms; } };
    };

    it("reports nothing on the first sweep after a long gap", async () => {
        const recorded = [];
        const { runtime, advance } = buildRuntime(recorded);
        for (const s of ["A", "B", "C"]) runtime.reflex.watch(s, { entryPaise: 10_000 });

        // Armed at boot, half an hour before the sweep is allowed to run.
        advance(30 * 60_000);
        await runtime.staleSweep();
        expect(recorded).toEqual([]);
    });

    it("measures silence from the resumption, then reports normally", async () => {
        const recorded = [];
        const { runtime, advance } = buildRuntime(recorded);
        runtime.reflex.watch("A", { entryPaise: 10_000 });

        advance(30 * 60_000);
        await runtime.staleSweep();          // resumption, re-anchors

        await sweepFor(runtime, advance, DEFAULT_STALE_AFTER_MS - 2_000);
        expect(recorded).toEqual([]);        // not yet silent for long enough

        await sweepFor(runtime, advance, 3_000);
        expect(recorded).toHaveLength(1);
    });

    it("re-anchors a symbol whose last tick was before the gap", async () => {
        const recorded = [];
        const { runtime, advance } = buildRuntime(recorded);
        runtime.reflex.watch("A", { entryPaise: 10_000 });
        runtime.ingestTick({ symbol: "A", price: 100 });   // a pre-market tick

        advance(30 * 60_000);
        await runtime.staleSweep();
        await sweepFor(runtime, advance, DEFAULT_STALE_AFTER_MS - 2_000);
        expect(recorded).toEqual([]);
    });

    it("keeps measuring across consecutive sweeps", async () => {
        const recorded = [];
        const { runtime, advance } = buildRuntime(recorded);
        runtime.reflex.watch("A", { entryPaise: 10_000 });
        await runtime.staleSweep();

        for (let i = 0; i < DEFAULT_STALE_AFTER_MS / 1_000; i += 1) {
            advance(1_000);
            await runtime.staleSweep();
        }
        expect(recorded).toEqual([]);
        advance(2_000);
        await runtime.staleSweep();
        expect(recorded).toHaveLength(1);
    });
});
