import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// Work that was raised, could not be handled, and had to wait.
//
// position_events was the durable side of the queue, but only recover() ever
// read it back, and recover() only runs at startup. A condition the queue
// expired or dropped at capacity was written back as PENDING and then sat there
// until the next restart. The LEASED and ABANDONED states and the attempts
// counter existed in the schema and nothing wrote them.

describe.skipIf(!TEST_DB || !TEST_REDIS)("unfinished event work", () => {
    let pool, redis, ports;
    const USER = 8493;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        ({ default: redis } = await import("../config/redis.js"));
        const { buildLivePorts } = await import("../services/autonomous/livePorts.js");
        ports = buildLivePorts({ userId: USER, newsStore: null, connectionTracker: null });
    });

    beforeEach(async () => {
        await pool.query("DELETE FROM position_events WHERE user_id=$1", [USER]);
        // Cooldowns are durable now, so a symbol priced by one test would
        // otherwise be skipped by the next.
        await pool.query("DELETE FROM candidate_cooldowns WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'events@test',100000000)
             ON CONFLICT (id) DO NOTHING`, [USER]);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const raise = async (key, over = {}) => ports.recordEvent({
        key, type: "STOP_APPROACHING", severity: "WARNING", symbol: "TCS",
        correlationId: "c-1", source: "reflex_lane", observed: {},
        reason: "approaching the stop", observedAt: new Date(), ...over,
    });

    const stateOf = async (id) => {
        const { rows } = await pool.query(
            "SELECT state, attempts, leased_until FROM position_events WHERE id=$1", [id]);
        return rows[0];
    };

    it("hands back work nobody is holding", async () => {
        const stored = await raise("ev-1");
        const claimed = await ports.claimPendingEvents({});
        expect(claimed.map((e) => e.storedId)).toContain(stored.id);
        expect(claimed[0].type).toBe("STOP_APPROACHING");
    });

    it("does not hand out work that is currently being reasoned about", async () => {
        const stored = await raise("ev-2");
        expect(await ports.leaseEvents([stored.id])).toBe(1);
        expect(await stateOf(stored.id)).toMatchObject({ state: "LEASED" });
        expect(await ports.claimPendingEvents({})).toHaveLength(0);
    });

    it("reclaims work whose holder died", async () => {
        const stored = await raise("ev-3");
        await ports.leaseEvents([stored.id], -1_000);   // a lease that already ran out
        const claimed = await ports.claimPendingEvents({});
        expect(claimed.map((e) => e.storedId)).toContain(stored.id);
    });

    it("never hands back something already handled", async () => {
        const stored = await raise("ev-4");
        await ports.markEventHandled(stored.id);
        expect(await ports.claimPendingEvents({})).toHaveLength(0);
        // And a lease cannot resurrect it.
        await ports.leaseEvents([stored.id]);
        expect(await stateOf(stored.id)).toMatchObject({ state: "HANDLED" });
    });

    it("returns failed work to the store and counts the attempt", async () => {
        const stored = await raise("ev-5");
        await ports.leaseEvents([stored.id]);
        await ports.markEventFailed(stored.id, "model timed out");
        const row = await stateOf(stored.id);
        expect(row.state).toBe("PENDING");
        expect(row.attempts).toBe(1);
        expect(await ports.claimPendingEvents({})).toHaveLength(1);
    });

    it("abandons a condition that keeps failing rather than retrying forever",
       async () => {
        const stored = await raise("ev-6");
        for (let i = 0; i < 5; i += 1) await ports.markEventFailed(stored.id, "still failing");
        expect((await stateOf(stored.id)).attempts).toBe(5);

        expect(await ports.claimPendingEvents({ maxAttempts: 5 })).toHaveLength(0);
        expect((await stateOf(stored.id)).state).toBe("ABANDONED");
    });

    // A condition that keeps happening while the brain is thinking about it
    // must not release the lease. Resetting the row to PENDING handed the same
    // condition to a second worker: two model calls and two decisions for one
    // question.
    it("a recurring condition does not release the lease on it", async () => {
        const stored = await raise("ev-7");
        await ports.leaseEvents([stored.id]);

        const again = await raise("ev-7", { reason: "still approaching the stop" });
        expect(again.id).toBe(stored.id);
        expect((await stateOf(stored.id)).state).toBe("LEASED");
        expect(await ports.claimPendingEvents({})).toHaveLength(0);
    });

    it("a recurring condition still releases an expired lease", async () => {
        const stored = await raise("ev-8");
        await ports.leaseEvents([stored.id], -1_000);
        await raise("ev-8", { reason: "happening again" });
        expect((await stateOf(stored.id)).state).toBe("PENDING");
        expect(await ports.claimPendingEvents({})).toHaveLength(1);
    });

    it("a recurring condition still refreshes what was observed", async () => {
        const stored = await raise("ev-9", { severity: "WARNING" });
        await raise("ev-9", { severity: "CRITICAL", reason: "it broke" });
        const { rows } = await pool.query(
            "SELECT severity, reason FROM position_events WHERE id=$1", [stored.id]);
        expect(rows[0].severity).toBe("CRITICAL");
        expect(rows[0].reason).toBe("it broke");
    });

    it("orders critical work ahead of the rest", async () => {
        await raise("ev-info", { severity: "INFO", type: "TARGET_APPROACHING" });
        await raise("ev-crit", { severity: "CRITICAL", type: "STOP_BREACH" });
        const claimed = await ports.claimPendingEvents({});
        expect(claimed[0].severity).toBe("CRITICAL");
    });
});
