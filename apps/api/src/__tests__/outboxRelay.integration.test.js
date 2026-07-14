import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

/**
 * Outbox relay integration: real Postgres + real Redis.
 * Skipped unless both TEST_DATABASE_URL and TEST_REDIS_URL are set.
 *
 * Covers the roadmap scenarios:
 *  - relay "killed" mid-batch (redis fails partway) -> nothing lost,
 *    duplicates allowed but bounded by at-least-once semantics
 *  - all published rows are stamped exactly once under normal operation
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

// The api's redis config module would connect to REDIS_URL; point it at the
// test instance BEFORE importing anything that pulls it in.
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

describe.skipIf(!TEST_DB || !TEST_REDIS)("outbox relay (integration)", () => {
    let pool, redis, backbone, streamName;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        redis = (await import("../config/redis.js")).default;
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        backbone = await import("../services/eventBackbone.js");
        const { streamNameFor } = await import("@zentrade/eventbus");
        streamName = streamNameFor("test.outbox.ping");
    });

    beforeEach(async () => {
        await pool.query("TRUNCATE outbox");
        await redis.del(streamName);
    });

    afterAll(async () => {
        await redis.del(streamName);
        await pool.end();
        redis.disconnect();
    });

    const enqueueN = async (n) => {
        for (let i = 0; i < n; i++) {
            await backbone.enqueueEvent({ type: "test.outbox.ping", v: 1, payload: { i } });
        }
    };

    it("relays enqueued events to the stream and stamps published_at", async () => {
        await enqueueN(25);
        const published = await backbone.relayOutboxOnce();
        expect(published).toBe(25);

        const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE published_at IS NULL");
        expect(rows[0].n).toBe(0);
        expect(await redis.xlen(streamName)).toBe(25);
    });

    it("enqueue inside a rolled-back transaction leaves no event behind (atomicity)", async () => {
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await backbone.enqueueEvent({ type: "test.outbox.ping", v: 1, payload: { i: -1 } }, client);
            await client.query("ROLLBACK");
        } finally {
            client.release();
        }
        const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM outbox");
        expect(rows[0].n).toBe(0);
        expect(await backbone.relayOutboxOnce()).toBe(0);
    });

    it("relay crash mid-batch loses nothing: rows stay unpublished and retry cleanly", async () => {
        await enqueueN(10);

        // make XADD blow up after 4 publishes — simulates the process dying mid-batch
        const original = redis.call.bind(redis);
        let xadds = 0;
        const spy = vi.spyOn(redis, "call").mockImplementation((...args) => {
            if (String(args[0]).toUpperCase() === "XADD") {
                xadds++;
                if (xadds > 4) return Promise.reject(new Error("redis died mid-batch"));
            }
            return original(...args);
        });

        await expect(backbone.relayOutboxOnce()).rejects.toThrow("mid-batch");
        spy.mockRestore();

        // transaction rolled back: ALL rows still unpublished (no loss)
        const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE published_at IS NULL");
        expect(rows[0].n).toBe(10);

        // retry publishes everything; the 4 pre-crash XADDs remain as duplicates
        const published = await backbone.relayOutboxOnce();
        expect(published).toBe(10);
        const streamLen = await redis.xlen(streamName);
        expect(streamLen).toBe(14); // 4 duplicates + 10 = at-least-once, never lost

        // and every duplicate shares an envelope id with a real entry (dedupe-able)
        const entries = await redis.xrange(streamName, "-", "+");
        const ids = entries.map(([, fields]) => JSON.parse(fields[1]).id);
        expect(new Set(ids).size).toBe(10);
    });

    it("concurrent relay passes never double-publish (SKIP LOCKED)", async () => {
        await enqueueN(40);
        const [a, b] = await Promise.all([backbone.relayOutboxOnce(), backbone.relayOutboxOnce()]);
        expect(a + b).toBe(40);
        expect(await redis.xlen(streamName)).toBe(40);
    });
});
