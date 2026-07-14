import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createConsumer, streamNameFor } from "@zentrade/eventbus";
import { runWithCorrelation, ensureCorrelationId, createLogger } from "@zentrade/observability";

/**
 * M6 roadmap test: one correlationId survives the whole journey —
 * HTTP request -> enqueueEvent (outbox) -> relay -> stream -> consumer
 * (contextWrapper) -> log record. Real Postgres + real Redis.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const CORRELATION = "cafe1234-1111-4222-8333-deadbeef0001";
const TYPE = "test.correlation.ping";

describe.skipIf(!TEST_DB || !TEST_REDIS)("correlation end-to-end (integration)", () => {
    let pool, redis, backbone, server, port;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        redis = (await import("../config/redis.js")).default;
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        backbone = await import("../services/eventBackbone.js");
        await pool.query("DELETE FROM outbox WHERE event_type = $1", [TYPE]);
        await redis.del(streamNameFor(TYPE));

        // a minimal app using the SAME middleware pattern as apps/api/index.js
        const app = express();
        app.use((req, res, next) => {
            const correlationId = ensureCorrelationId(req.headers["x-correlation-id"]);
            res.setHeader("X-Correlation-Id", correlationId);
            runWithCorrelation(correlationId, next);
        });
        app.post("/ping", async (req, res) => {
            const envelope = await backbone.enqueueEvent({ type: TYPE, v: 1, payload: { ping: true } });
            res.json({ envelopeCorrelation: envelope.correlationId });
        });
        await new Promise((resolve) => {
            server = app.listen(0, resolve);
        });
        port = server.address().port;
    });

    afterAll(async () => {
        server?.close();
        await redis.del(streamNameFor(TYPE));
        await pool.end();
        redis.disconnect();
    });

    it("the id from the HTTP header reaches the consumer's log record unchanged", async () => {
        // 1. HTTP in with a caller-supplied correlation id
        const res = await fetch(`http://127.0.0.1:${port}/ping`, {
            method: "POST",
            headers: { "X-Correlation-Id": CORRELATION },
        });
        expect(res.headers.get("x-correlation-id")).toBe(CORRELATION);
        expect((await res.json()).envelopeCorrelation).toBe(CORRELATION);

        // 2. outbox row carries it
        const { rows } = await pool.query("SELECT payload FROM outbox WHERE event_type = $1", [TYPE]);
        expect(rows[0].payload.correlationId).toBe(CORRELATION);

        // 3. relay to the stream
        await backbone.relayOutboxOnce();

        // 4. consumer runs inside the envelope scope; its log carries the id
        const records = [];
        const testLogger = createLogger({ format: "json", sink: (_line, record) => records.push(record) });
        const dedicated = redis.duplicate();
        const consumer = createConsumer(dedicated, {
            stream: streamNameFor(TYPE),
            group: "correlation-test",
            consumer: "c1",
            contextWrapper: (envelope, run) => runWithCorrelation(envelope.correlationId, run),
            handler: async () => {
                testLogger.info("TestConsumer", "handled ping");
            },
        });
        const drained = await consumer.drainOnce();
        dedicated.disconnect();

        expect(drained).toBe(1);
        expect(records).toHaveLength(1);
        expect(records[0].correlationId).toBe(CORRELATION);
    });
});
