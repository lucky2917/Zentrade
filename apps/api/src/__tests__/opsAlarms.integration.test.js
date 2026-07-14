import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Ops alarms (M6): cooldown semantics and backbone gauge updates.
 * Real Redis (cooldown keys) + real Postgres (outbox age query).
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

describe.skipIf(!TEST_DB || !TEST_REDIS)("ops alarms (integration)", () => {
    let pool, redis, alarms, metrics;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        redis = (await import("../config/redis.js")).default;
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        alarms = await import("../services/opsAlarms.js");
        ({ metrics } = await import("@zentrade/observability"));
        await redis.del("alarm:cooldown:test_alarm");
    });

    afterAll(async () => {
        await redis.del("alarm:cooldown:test_alarm");
        await pool.end();
        redis.disconnect();
    });

    it("raiseAlarm fires once, then respects the cooldown", async () => {
        const first = await alarms.raiseAlarm("test_alarm", "Test alarm", ["detail line"]);
        const second = await alarms.raiseAlarm("test_alarm", "Test alarm", ["detail line"]);
        expect(first).toBe(true); // fired (mailer may be unconfigured; alarm still counts)
        expect(second).toBe(false); // suppressed by cooldown
        const ttl = await redis.ttl("alarm:cooldown:test_alarm");
        expect(ttl).toBeGreaterThan(60);
    });

    it("checkBackboneHealth updates gauges and stays silent on a healthy backbone", async () => {
        await pool.query("DELETE FROM outbox WHERE published_at IS NULL");
        await redis.del("events:dlq", "alarm:cooldown:outbox_lag", "alarm:cooldown:dlq_nonempty");

        await alarms.checkBackboneHealth();

        const snap = metrics.snapshot();
        expect(snap.gauges["outbox.unpublished"]).toBe(0);
        expect(snap.gauges["eventbus.dlq_length"]).toBe(0);
        expect(await redis.exists("alarm:cooldown:outbox_lag")).toBe(0); // no alarm raised
    });
});
