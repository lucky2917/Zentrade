import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Redis from "ioredis";
import {
    createPublisher,
    createConsumer,
    createEnvelope,
    replay,
    groupLag,
    streamNameFor,
    DLQ_STREAM,
    type EventEnvelope,
} from "../index.js";

/**
 * Integration tests against a real Redis (Streams have no honest fake).
 * Skipped unless TEST_REDIS_URL is set; CI provides a redis:7 service.
 * Uses a throwaway event-type namespace and flushes only its own keys.
 */
const TEST_REDIS = process.env.TEST_REDIS_URL;

const TYPE = "test.bus.ping";
const STREAM = streamNameFor(TYPE);

describe.skipIf(!TEST_REDIS)("eventbus (integration, real Redis Streams)", () => {
    let redis: Redis;
    let consumerConn: Redis;

    const envelope = (n: number): EventEnvelope =>
        createEnvelope({ type: TYPE, v: 1, source: "test", payload: { n } });

    beforeAll(() => {
        redis = new Redis(TEST_REDIS!);
        consumerConn = new Redis(TEST_REDIS!);
    });

    beforeEach(async () => {
        await redis.del(STREAM, DLQ_STREAM);
    });

    afterAll(async () => {
        await redis.del(STREAM, DLQ_STREAM);
        redis.disconnect();
        consumerConn.disconnect();
    });

    it("publishes validated envelopes and a consumer group receives + acks them", async () => {
        const publisher = createPublisher(redis);
        for (let i = 0; i < 10; i++) await publisher.publish(envelope(i));

        const seen: number[] = [];
        const consumer = createConsumer(consumerConn, {
            stream: STREAM,
            group: "g1",
            consumer: "c1",
            handler: async (env) => {
                seen.push((env.payload as { n: number }).n);
            },
        });
        const drained = await consumer.drainOnce();

        expect(drained).toBe(10);
        expect(seen).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const lag = await groupLag(redis, STREAM, "g1");
        expect(lag.pending).toBe(0); // everything acked
        expect(lag.streamLength).toBe(10);
    });

    it("rejects malformed envelopes at publish", async () => {
        const publisher = createPublisher(redis);
        await expect(
            publisher.publish({ ...envelope(1), id: "not-a-uuid" } as EventEnvelope),
        ).rejects.toThrow();
        expect(await redis.xlen(STREAM)).toBe(0);
    });

    it("a poison message dead-letters after maxDeliveries and unblocks the group", async () => {
        const publisher = createPublisher(redis);
        await publisher.publish(envelope(666));
        await publisher.publish(envelope(1));

        let goodSeen = 0;
        const consumer = createConsumer(consumerConn, {
            stream: STREAM,
            group: "g2",
            consumer: "c1",
            maxDeliveries: 3,
            handler: async (env) => {
                if ((env.payload as { n: number }).n === 666) throw new Error("poison");
                goodSeen++;
            },
        });

        await consumer.drainOnce(); // delivery 1: poison fails, good acks
        await consumer.retryNow(); // delivery 2
        await consumer.retryNow(); // delivery 3 -> maxDeliveries reached -> DLQ

        expect(goodSeen).toBe(1);
        const dlq = await redis.xrange(DLQ_STREAM, "-", "+");
        expect(dlq.length).toBe(1);
        const fields = new Map<string, string>();
        const entryFields = dlq[0]![1];
        for (let i = 0; i < entryFields.length - 1; i += 2) fields.set(entryFields[i]!, entryFields[i + 1]!);
        expect(fields.get("stream")).toBe(STREAM);
        expect(fields.get("reason")).toContain("poison");

        const lag = await groupLag(redis, STREAM, "g2");
        expect(lag.pending).toBe(0); // poison acked away, nothing stuck
    });

    it("a corrupt entry (schema-invalid envelope) dead-letters instead of looping", async () => {
        await redis.xadd(STREAM, "*", "envelope", JSON.stringify({ garbage: true }));
        const consumer = createConsumer(consumerConn, {
            stream: STREAM,
            group: "g3",
            consumer: "c1",
            maxDeliveries: 1,
            handler: async () => {},
        });
        await consumer.drainOnce();
        expect((await redis.xrange(DLQ_STREAM, "-", "+")).length).toBe(1);
    });

    it("replay from the beginning reproduces the exact published sequence", async () => {
        const publisher = createPublisher(redis);
        const published: string[] = [];
        for (let i = 0; i < 250; i++) {
            const env = envelope(i);
            published.push(env.id);
            await publisher.publish(env);
        }

        const replayed: string[] = [];
        const count = await replay(redis, STREAM, "-", async (env) => {
            replayed.push(env.id);
        }, 100); // 3 pages: exercises cursor pagination

        expect(count).toBe(250);
        expect(replayed).toEqual(published);
    });

    it("at-least-once: an unacked entry survives a consumer crash and is redelivered", async () => {
        const publisher = createPublisher(redis);
        await publisher.publish(envelope(7));

        // consumer A reads but "crashes" before ack
        const crashed = createConsumer(consumerConn, {
            stream: STREAM,
            group: "g4",
            consumer: "cA",
            handler: async () => {
                throw new Error("crash before ack");
            },
        });
        await crashed.drainOnce();

        // consumer B claims and processes it
        const seen: number[] = [];
        const survivor = createConsumer(consumerConn, {
            stream: STREAM,
            group: "g4",
            consumer: "cB",
            maxDeliveries: 10,
            handler: async (env) => {
                seen.push((env.payload as { n: number }).n);
            },
        });
        await survivor.retryNow();

        expect(seen).toEqual([7]);
        expect((await groupLag(redis, STREAM, "g4")).pending).toBe(0);
    });
});
