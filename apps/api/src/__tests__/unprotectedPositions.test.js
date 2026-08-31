import { describe, expect, it, vi } from "vitest";
import { CROSSING } from "../services/tick/reflex.js";

// A position nobody is protecting.
//
// armOpenPositions skips a holding with no thesis, and the reflex refuses a
// commitment that carries no stop, target or invalidation level. Both are
// correct — you cannot protect a level that does not exist — but both were
// silent. `armed` came back lower than `positions` and nothing looked at the
// difference, so the single most dangerous state in the system (real capital,
// no stop) reached the operator as a number in a narration payload.

const position = (over = {}) => ({
    symbol: "RELIANCE", quantity: 100, side: "BUY", entryPricePaise: 100_000,
    thesisId: "t-1", correlationId: "c-1", stopPaise: 98_000, targetPaise: 108_000,
    ...over,
});

const makeRuntime = async (positions) => {
    const { AutonomousRuntime, MODE } = await import("../services/autonomous/runtime.js");
    return new AutonomousRuntime({
        engine: { openOrders: async () => [] }, reconciler: null,
        mode: MODE.PAPER, userId: 1,
        ports: { loadPositions: async () => positions },
    });
};

describe("a position with nothing protecting it is reported as such", () => {
    it("arms a position that carries levels and reports nothing unprotected",
       async () => {
        const runtime = await makeRuntime([position()]);
        const result = await runtime.armOpenPositions();
        expect(result).toMatchObject({ armed: 1, positions: 1 });
        expect(result.unprotected).toEqual([]);
        expect(runtime.reflex.isArmed("RELIANCE")).toBe(true);
        expect(runtime.health().unprotectedPositions).toEqual([]);
    });

    it("names the position whose thesis carries no level at all", async () => {
        const runtime = await makeRuntime([
            position({ stopPaise: null, targetPaise: null }),
        ]);
        const result = await runtime.armOpenPositions();
        expect(result.armed).toBe(0);
        expect(result.unprotected).toEqual([
            { symbol: "RELIANCE", quantity: 100, reason: "the thesis records no stop or target" },
        ]);
        expect(runtime.metrics.unprotectedPositions).toBe(1);
    });

    it("names a holding that has no thesis behind it", async () => {
        const runtime = await makeRuntime([position({ thesisId: null })]);
        const result = await runtime.armOpenPositions();
        expect(result.armed).toBe(0);
        expect(result.unprotected).toEqual([
            { symbol: "RELIANCE", quantity: 100, reason: "no open thesis" },
        ]);
    });

    it("keeps reporting it in health, not only at the moment of recovery",
       async () => {
        const runtime = await makeRuntime([position({ thesisId: null })]);
        await runtime.armOpenPositions();
        expect(runtime.health().unprotectedPositions).toEqual([
            { symbol: "RELIANCE", quantity: 100, reason: "no open thesis" },
        ]);
    });

    it("clears the report once the position is protected", async () => {
        const holding = position({ thesisId: null });
        const runtime = await makeRuntime([holding]);
        await runtime.armOpenPositions();
        expect(runtime.health().unprotectedPositions).toHaveLength(1);

        holding.thesisId = "t-1";
        await runtime.armOpenPositions();
        expect(runtime.health().unprotectedPositions).toEqual([]);
        expect(runtime.reflex.isArmed("RELIANCE")).toBe(true);
    });

    // The audit runs on a timer, so it must never disturb a symbol it is
    // already protecting: re-arming clears the latches and would re-fire a
    // level the lane has already acted on.
    it("leaves an already-armed symbol untouched when it runs again", async () => {
        const runtime = await makeRuntime([position()]);
        await runtime.armOpenPositions();
        const commitment = runtime.reflex.armed.get("RELIANCE");
        const armedAt = commitment.armedAt;
        // The stop has been seen and acted on; the latch is what stops it
        // firing again on every subsequent tick.
        commitment.fired.add(CROSSING.STOP);

        // A second pass, as the periodic audit runs it every thirty seconds.
        const again = await runtime.armOpenPositions();
        expect(again.armed).toBe(1);
        expect(again.unprotected).toEqual([]);

        // Same commitment object, same latch, same instant it was armed.
        expect(runtime.reflex.armed.get("RELIANCE").fired.has(CROSSING.STOP)).toBe(true);
        expect(runtime.reflex.armed.get("RELIANCE").armedAt).toBe(armedAt);
        // And the level genuinely does not fire again.
        const after = runtime.reflex.onTick({ symbol: "RELIANCE", pricePaise: 96_500, at: 2 });
        expect(after.map((c) => c.kind)).not.toContain(CROSSING.STOP);
    });

    it("picks up a position that lost its cover after the last pass", async () => {
        const positions = [position({ symbol: "TCS" })];
        const runtime = await makeRuntime(positions);
        await runtime.armOpenPositions();
        expect(runtime.reflex.isArmed("TCS")).toBe(true);

        // A second holding appears without having been armed.
        positions.push(position({ symbol: "INFY" }));
        const audit = await runtime.armOpenPositions();
        expect(audit.armed).toBe(2);
        expect(runtime.reflex.isArmed("INFY")).toBe(true);
    });

    // The audit runs every thirty seconds. Repeating the same warning on every
    // pass would push the events an operator needs out of the cockpit's ring.
    it("reports a standing condition once, not on every pass", async () => {
        const narrated = [];
        const runtime = await makeRuntime([position({ thesisId: null })]);
        runtime.narrator = { emit: (kind, payload) => { narrated.push({ kind, payload }); } };

        await runtime.armOpenPositions();
        await runtime.armOpenPositions();
        await runtime.armOpenPositions();
        expect(narrated).toHaveLength(1);
        // Still reported in health throughout, which is where it belongs.
        expect(runtime.health().unprotectedPositions).toHaveLength(1);
    });

    it("reports again when a different position becomes uncovered", async () => {
        const narrated = [];
        const positions = [position({ symbol: "TCS", thesisId: null })];
        const runtime = await makeRuntime(positions);
        runtime.narrator = { emit: (kind, payload) => { narrated.push({ kind, payload }); } };

        await runtime.armOpenPositions();
        expect(narrated).toHaveLength(1);

        positions.push(position({ symbol: "INFY", thesisId: null }));
        await runtime.armOpenPositions();
        expect(narrated).toHaveLength(2);
        expect(narrated[1].payload.symbols).toEqual(["TCS", "INFY"]);
    });

    it("protects the ones it can and reports only the one it cannot", async () => {
        const runtime = await makeRuntime([
            position({ symbol: "TCS" }),
            position({ symbol: "INFY", stopPaise: null, targetPaise: null }),
        ]);
        const result = await runtime.armOpenPositions();
        expect(result.armed).toBe(1);
        expect(runtime.reflex.isArmed("TCS")).toBe(true);
        expect(result.unprotected.map((p) => p.symbol)).toEqual(["INFY"]);
    });
});
