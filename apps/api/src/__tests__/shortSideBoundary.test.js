import { describe, expect, it } from "vitest";
import { LEGAL_CANDIDATE_ACTIONS, LEGAL_POSITION_ACTIONS }
    from "../services/reasoning/pipeline.js";
import { reducePosition } from "../services/execution/bookkeeper.js";
import { buyMarginPaise, sellCreditPaise } from "../services/execution/ledger.js";
import { DIRECTION, ReflexLane, CROSSING } from "../services/tick/reflex.js";

// The short side: deliberately not implemented, and pinned so it cannot be
// half-enabled by accident.
//
// The money model has no short in it. `buyMarginPaise` prices a long's margin,
// `sellCreditPaise` releases margin the position already consumed, and neither
// models borrow cost, short margin or a negative holding. Three layers refuse a
// negative position today: the reasoning pipeline's legal actions, the engine's
// fill check and the bookkeeper.
//
// Enabling entry-side shorts means changing the ledger, which is the one module
// that must never be changed casually — a flat round trip through a broken
// ledger destroyed Rs 2,00,220 once already. There is no measured need, the
// system is paper-only, and the correct engineering answer is to leave it
// closed and say so.
//
// What IS ready: the reflex and the Go plane already mirror levels for a short,
// because a level test that only works one way is a latent bug rather than a
// deferred feature.

describe("the short side is closed, deliberately and completely", () => {
    it("reasoning cannot propose opening a short", () => {
        expect(LEGAL_CANDIDATE_ACTIONS).toEqual(["BUY", "HOLD"]);
        expect(LEGAL_CANDIDATE_ACTIONS).not.toContain("SELL");
        expect(LEGAL_CANDIDATE_ACTIONS).not.toContain("SHORT");
    });

    it("position actions only ever reduce or add to an existing long", () => {
        expect(LEGAL_POSITION_ACTIONS).toEqual(["HOLD", "REDUCE", "EXIT", "ADD"]);
        expect(LEGAL_POSITION_ACTIONS).not.toContain("SHORT");
    });

    it("the bookkeeper refuses to take a holding negative", async () => {
        await expect(reducePosition({}, {
            userId: 1, symbol: "RELIANCE", mode: "INTRADAY",
            quantity: 10, heldQuantity: 4, remainingMarginPaise: 0,
        })).rejects.toThrow(/negative position/);
    });

    it("the ledger prices a long and has no short equivalent", () => {
        // Margin for a long is derived from the notional it controls.
        expect(buyMarginPaise({ quantity: 10, pricePaise: 100_000, mode: "INTRADAY" }))
            .toBe(200_000);
        // A sell releases margin the position already consumed. With no holding
        // there is nothing to release, which is what makes this a long-only
        // model rather than a symmetric one.
        expect(sellCreditPaise({
            quantity: 10, heldQuantity: 0, marginUsedPaise: 0,
            avgPricePaise: 100_000, pricePaise: 90_000, mode: "INTRADAY",
        })).toBe(-100_000 - 2000);
    });

    // The fast path is symmetric already. A level test that only works one way
    // is a latent bug, not a deferred feature.
    it("the reflex protects a short correctly, for when the ledger supports one", () => {
        const lane = new ReflexLane({ clock: () => 0 });
        lane.arm("RELIANCE", {
            thesisId: "t-1", direction: DIRECTION.SHORT,
            stopPaise: 102_000, targetPaise: 92_000, quantity: 10,
        });
        // A short is stopped ABOVE and targets BELOW.
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 101_000, at: 1 })).toEqual([]);
        expect(lane.onTick({ symbol: "RELIANCE", pricePaise: 102_500, at: 2 })
            .map((c) => c.kind)).toEqual([CROSSING.STOP]);

        const winner = new ReflexLane({ clock: () => 0 });
        winner.arm("TCS", { thesisId: "t-2", direction: DIRECTION.SHORT,
                            stopPaise: 102_000, targetPaise: 92_000, quantity: 10 });
        expect(winner.onTick({ symbol: "TCS", pricePaise: 91_000, at: 1 })
            .map((c) => c.kind)).toEqual([CROSSING.TARGET]);
    });
});
