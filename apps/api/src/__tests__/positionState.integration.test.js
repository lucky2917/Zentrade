import { afterAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const {
    buildPositionState, unrealisedPnlPaise, pnlPercent, distanceToLevel,
    sessionPhase, istMinutesOf, STALE_AFTER_MS,
} = await import("../services/autonomous/positionState.js");

// Pure arithmetic first — these need no database and guard the units, which is
// where a P&L bug would hide.
describe("position arithmetic", () => {
    it("computes long P&L in paise", () => {
        expect(unrealisedPnlPaise({
            side: "BUY", quantity: 10, entryPricePaise: 100000, currentPricePaise: 101000,
        })).toBe(10000);
    });

    it("computes short P&L with the sign reversed", () => {
        expect(unrealisedPnlPaise({
            side: "SELL", quantity: 10, entryPricePaise: 100000, currentPricePaise: 99000,
        })).toBe(10000);
    });

    it("reports a loss as negative for both sides", () => {
        expect(unrealisedPnlPaise({ side: "BUY", quantity: 5, entryPricePaise: 100000, currentPricePaise: 98000 })).toBe(-10000);
        expect(unrealisedPnlPaise({ side: "SELL", quantity: 5, entryPricePaise: 100000, currentPricePaise: 102000 })).toBe(-10000);
    });

    it("computes percentage move independent of quantity", () => {
        expect(pnlPercent({ side: "BUY", entryPricePaise: 100000, currentPricePaise: 105000 })).toBeCloseTo(5);
        expect(pnlPercent({ side: "SELL", entryPricePaise: 100000, currentPricePaise: 95000 })).toBeCloseTo(5);
    });

    it("does not divide by zero on a zero entry price", () => {
        expect(pnlPercent({ side: "BUY", entryPricePaise: 0, currentPricePaise: 100 })).toBe(0);
    });
});

describe("distance to stop and target", () => {
    it("is 1 at entry and 0 at the level", () => {
        expect(distanceToLevel(100000, 100000, 95000)).toBe(1);
        expect(distanceToLevel(95000, 100000, 95000)).toBe(0);
    });

    it("goes negative once the level is breached", () => {
        expect(distanceToLevel(94000, 100000, 95000)).toBeLessThan(0);
    });

    it("is null when the thesis recorded no level", () => {
        expect(distanceToLevel(100000, 100000, null)).toBeNull();
        expect(distanceToLevel(100000, 100000, undefined)).toBeNull();
    });
});

describe("session phase", () => {
    const at = (h, m) => sessionPhase(h * 60 + m);
    it.each([
        [8, 0, "PRE_OPEN"], [9, 14, "PRE_OPEN"], [9, 15, "OPEN"], [9, 29, "OPEN"],
        [9, 30, "EARLY_SESSION"], [10, 59, "EARLY_SESSION"], [11, 0, "MID_SESSION"],
        [13, 59, "MID_SESSION"], [14, 0, "LATE_SESSION"], [15, 19, "LATE_SESSION"],
        [15, 20, "CLOSE"], [15, 30, "CLOSE"], [15, 31, "POST_CLOSE"], [23, 0, "POST_CLOSE"],
    ])("%s:%s is %s", (h, m, want) => { expect(at(h, m)).toBe(want); });

    it("derives IST minutes from a UTC instant", () => {
        expect(istMinutesOf(new Date("2026-08-31T03:45:00Z"))).toBe(9 * 60 + 15);
    });
});

describe("position state assembly", () => {
    const now = new Date("2026-08-31T05:00:00Z");
    const holding = { user_id: 1, symbol: "RELIANCE", quantity: 10, avg_price_paise: 100000 };
    const thesis = {
        id: "t-1", correlation_id: "c-1", side: "BUY",
        opened_at: new Date("2026-08-31T04:00:00Z").toISOString(),
        stop_paise: 95000, target_paise: 110000,
    };

    it("converts a rupee tick into paise exactly once", () => {
        const state = buildPositionState({
            holding, thesis,
            tick: { price: 1010, timestamp: now.toISOString() }, now,
        });
        expect(state.currentPricePaise).toBe(101000);
        expect(state.unrealisedPnlPaise).toBe(10000);
        expect(state.exposurePaise).toBe(1010000);
    });

    it("marks data stale when the tick is too old, and reports no P&L for a missing tick", () => {
        const old = new Date(now.getTime() - STALE_AFTER_MS - 1000);
        const staleState = buildPositionState({
            holding, thesis, tick: { price: 1010, timestamp: old.toISOString() }, now });
        expect(staleState.stale).toBe(true);

        const missing = buildPositionState({ holding, thesis, tick: null, now });
        expect(missing.stale).toBe(true);
        expect(missing.currentPricePaise).toBeNull();
        expect(missing.unrealisedPnlPaise).toBeNull();
    });

    it("flags a position that has no thesis", () => {
        const state = buildPositionState({
            holding, thesis: null, tick: { price: 1010, timestamp: now.toISOString() }, now });
        expect(state.hasThesis).toBe(false);
        expect(state.thesisId).toBeNull();
    });

    it("computes holding duration from the thesis", () => {
        const state = buildPositionState({
            holding, thesis, tick: { price: 1010, timestamp: now.toISOString() }, now });
        expect(state.holdingSeconds).toBe(3600);
    });
});

describe.skipIf(!TEST_DB || !TEST_REDIS)("thesis persistence (integration)", () => {
    let pool, thesisApi;

    beforeEach(async () => {
        ({ pool } = await import("../config/db.js"));
        thesisApi = await import("../services/autonomous/thesis.js");
        await pool.query("DELETE FROM position_reassessments");
        await pool.query("DELETE FROM position_events");
        await pool.query("DELETE FROM trade_thesis");
        await pool.query(
            "INSERT INTO users (id, email, balance_paise) VALUES (99, 'auto@test', 10000000) ON CONFLICT (id) DO NOTHING");
    });

    afterAll(async () => { if (pool) await pool.end(); });

    const validInput = (over = {}) => ({
        userId: 99, symbol: "TESTAUTO", correlationId: "corr-a", side: "BUY",
        entryPricePaise: 100000, quantity: 10, rationale: "breakout above resistance",
        setupType: "breakout", invalidationConditions: ["close below 990"],
        supportingEvidence: [{ id: "ev-1" }], horizon: "INTRADAY",
        stopPaise: 95000, targetPaise: 110000, ...over,
    });

    it("rejects a thesis with no invalidation condition", async () => {
        await expect(thesisApi.recordThesis(validInput({ invalidationConditions: [] })))
            .rejects.toThrow(/invalidation/);
    });

    it("rejects malformed input without writing", async () => {
        await expect(thesisApi.recordThesis(validInput({ side: "MAYBE" }))).rejects.toThrow();
        await expect(thesisApi.recordThesis(validInput({ quantity: 0 }))).rejects.toThrow();
        const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM trade_thesis");
        expect(rows[0].n).toBe(0);
    });

    it("records and reads back an open thesis", async () => {
        const created = await thesisApi.recordThesis(validInput());
        expect(created.symbol).toBe("TESTAUTO");
        const open = await thesisApi.openThesisFor(99, "TESTAUTO");
        expect(open.id).toBe(created.id);
        expect(open.invalidation_conditions).toEqual(["close below 990"]);
    });

    it("is idempotent on correlation id", async () => {
        const a = await thesisApi.recordThesis(validInput());
        const b = await thesisApi.recordThesis(validInput());
        expect(b.id).toBe(a.id);
        const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM trade_thesis");
        expect(rows[0].n).toBe(1);
    });

    it("refuses to rewrite an entry thesis", async () => {
        const created = await thesisApi.recordThesis(validInput());
        await expect(pool.query(
            "UPDATE trade_thesis SET rationale='rewritten' WHERE id=$1", [created.id]))
            .rejects.toThrow(/immutable/);
    });

    it("allows closing, and a closed thesis is no longer open", async () => {
        const created = await thesisApi.recordThesis(validInput());
        await thesisApi.closeThesis(created.id, "EXIT");
        expect(await thesisApi.openThesisFor(99, "TESTAUTO")).toBeNull();
    });

    it("records reassessments against the original thesis", async () => {
        const created = await thesisApi.recordThesis(validInput());
        await thesisApi.recordReassessment({
            thesisId: created.id, correlationId: "corr-a", action: "HOLD",
            confidence: "MEDIUM", thesisStillValid: true, whatChanged: "nothing material",
            material: false, reasoning: "structure intact", evidence: [],
            unrealisedPnlPaise: 5000, currentPricePaise: 100500, holdingSeconds: 600,
        });
        const all = await thesisApi.reassessmentsFor(created.id);
        expect(all).toHaveLength(1);
        expect(all[0].action).toBe("HOLD");
        const still = await thesisApi.openThesisFor(99, "TESTAUTO");
        expect(still.rationale).toBe("breakout above resistance");
    });

    it("rejects an illegal reassessment action at the database", async () => {
        const created = await thesisApi.recordThesis(validInput());
        await expect(thesisApi.recordReassessment({
            thesisId: created.id, correlationId: "corr-a", action: "MOON",
            confidence: "HIGH", thesisStillValid: true, whatChanged: "x",
            material: false, reasoning: "y", evidence: [],
            unrealisedPnlPaise: 0, currentPricePaise: 100000, holdingSeconds: 1,
        })).rejects.toThrow();
    });
});
