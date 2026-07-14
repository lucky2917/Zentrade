import { z } from "zod";
import { EventEnvelopeBase } from "@zentrade/contracts";

/**
 * Redis Streams event bus.
 *
 * Design rules (constitutional):
 *  - envelopes are validated at publish AND at consume — the bus never
 *    trusts its own transport
 *  - delivery is at-least-once; consumers are expected to be idempotent
 *    (envelope ids are stable for dedupe)
 *  - a message that keeps failing goes to the dead-letter stream with its
 *    failure context instead of poisoning the group forever
 *  - streams are capped (MAXLEN ~) so a quiet consumer can never OOM Redis
 *
 * The redis client is injected through a minimal `call` interface, so the
 * package has no redis dependency and any ioredis-compatible client works.
 * Consumers MUST be given a dedicated (duplicated) connection — XREADGROUP
 * blocks the socket.
 */

export interface RedisLike {
    call(command: string, ...args: (string | number | Buffer)[]): Promise<unknown>;
}

export type EventEnvelope = z.infer<typeof EventEnvelopeBase>;

export const DLQ_STREAM = "events:dlq";
export const streamNameFor = (eventType: string): string => `events:${eventType}`;

export interface BusOptions {
    /** cap per stream; ~100k envelopes is days of headroom at current volumes */
    maxStreamLength?: number;
}

export interface PublishResult {
    stream: string;
    entryId: string;
}

export const createPublisher = (redis: RedisLike, options: BusOptions = {}) => {
    const maxLen = options.maxStreamLength ?? 100_000;

    const publish = async (envelope: EventEnvelope): Promise<PublishResult> => {
        const parsed = EventEnvelopeBase.parse(envelope); // validate at publish
        const stream = streamNameFor(parsed.type);
        const entryId = (await redis.call(
            "XADD",
            stream,
            "MAXLEN",
            "~",
            String(maxLen),
            "*",
            "envelope",
            JSON.stringify(parsed),
        )) as string;
        return { stream, entryId };
    };

    return { publish };
};

export interface ConsumerOptions {
    stream: string;
    group: string;
    consumer: string;
    handler: (envelope: EventEnvelope, meta: { entryId: string; deliveryCount: number }) => Promise<void>;
    /** structural validation beyond the base envelope (a defineEvent schema) */
    schema?: z.ZodType;
    /** block time per read; keep short so stop() is responsive */
    blockMs?: number;
    batchSize?: number;
    /** attempts before an entry is dead-lettered (including the first) */
    maxDeliveries?: number;
    /** how long an entry may sit unacked before another pass retries it */
    retryMinIdleMs?: number;
    onError?: (err: unknown, context: string) => void;
}

interface PendingEntry {
    entryId: string;
    deliveryCount: number;
}

const parseEnvelopeFields = (fields: string[]): string | null => {
    for (let i = 0; i < fields.length - 1; i += 2) {
        if (fields[i] === "envelope") return fields[i + 1] ?? null;
    }
    return null;
};

export const createConsumer = (redis: RedisLike, options: ConsumerOptions) => {
    const {
        stream,
        group,
        consumer,
        handler,
        schema,
        blockMs = 2_000,
        batchSize = 32,
        maxDeliveries = 5,
        retryMinIdleMs = 15_000,
        onError = () => {},
    } = options;

    let running = false;
    let loopPromise: Promise<void> | null = null;

    const ensureGroup = async (): Promise<void> => {
        try {
            await redis.call("XGROUP", "CREATE", stream, group, "0", "MKSTREAM");
        } catch (err) {
            if (!String(err).includes("BUSYGROUP")) throw err;
        }
    };

    const deadLetter = async (entryId: string, raw: string | null, reason: string): Promise<void> => {
        await redis.call(
            "XADD",
            DLQ_STREAM,
            "MAXLEN",
            "~",
            "10000",
            "*",
            "stream",
            stream,
            "group",
            group,
            "entryId",
            entryId,
            "reason",
            reason.slice(0, 500),
            "envelope",
            raw ?? "",
        );
        await redis.call("XACK", stream, group, entryId);
    };

    const processEntry = async (entryId: string, fields: string[], deliveryCount: number): Promise<void> => {
        const raw = parseEnvelopeFields(fields);
        try {
            if (raw == null) throw new Error("entry has no envelope field");
            const base = EventEnvelopeBase.parse(JSON.parse(raw)); // validate at consume
            const envelope = schema ? (schema.parse(base) as EventEnvelope) : base;
            await handler(envelope, { entryId, deliveryCount });
            await redis.call("XACK", stream, group, entryId);
        } catch (err) {
            onError(err, `handling ${stream}/${entryId} (delivery ${deliveryCount})`);
            if (deliveryCount >= maxDeliveries) {
                await deadLetter(entryId, raw, String(err));
            }
            // otherwise: leave pending; the retry pass reclaims it after minIdle
        }
    };

    /**
     * Retry pass: reclaim entries whose consumer died or whose handler failed.
     * minIdle 0 (tests/replay) retries immediately; production uses
     * retryMinIdleMs so in-flight work isn't stolen.
     */
    const retryPending = async (minIdleMs: number): Promise<void> => {
        const pending = (await redis.call(
            "XPENDING",
            stream,
            group,
            "IDLE",
            String(minIdleMs),
            "-",
            "+",
            String(batchSize),
        )) as [string, string, number, number][] | null;
        if (!pending || pending.length === 0) return;

        for (const [entryId, , , deliveryCount] of pending) {
            const claimed = (await redis.call(
                "XCLAIM",
                stream,
                group,
                consumer,
                String(minIdleMs),
                entryId,
            )) as [string, string[]][] | null;
            const entry = claimed?.[0];
            if (!entry) continue; // someone else claimed it
            // XCLAIM increments delivery count; report the post-claim count
            await processEntry(entry[0], entry[1], deliveryCount + 1);
        }
    };

    const readBatch = async (): Promise<PendingEntry[]> => {
        const reply = (await redis.call(
            "XREADGROUP",
            "GROUP",
            group,
            consumer,
            "COUNT",
            String(batchSize),
            "BLOCK",
            String(blockMs),
            "STREAMS",
            stream,
            ">",
        )) as [string, [string, string[]][]][] | null;

        const processed: PendingEntry[] = [];
        if (!reply) return processed;
        for (const [, entries] of reply) {
            for (const [entryId, fields] of entries) {
                await processEntry(entryId, fields, 1);
                processed.push({ entryId, deliveryCount: 1 });
            }
        }
        return processed;
    };

    const start = (): void => {
        if (running) return;
        running = true;
        loopPromise = (async () => {
            await ensureGroup();
            let lastRetryPass = 0;
            while (running) {
                try {
                    await readBatch();
                    const now = Date.now();
                    if (now - lastRetryPass >= retryMinIdleMs) {
                        lastRetryPass = now;
                        await retryPending(retryMinIdleMs);
                    }
                } catch (err) {
                    onError(err, `consumer loop ${stream}/${group}`);
                    // transient redis failure: back off instead of hot-looping
                    await new Promise((r) => setTimeout(r, 1_000));
                }
            }
        })();
    };

    const stop = async (): Promise<void> => {
        running = false;
        await loopPromise;
    };

    /** Drain everything currently deliverable, then return (test/ops helper). */
    const drainOnce = async (): Promise<number> => {
        await ensureGroup();
        let total = 0;
        for (;;) {
            const reply = (await redis.call(
                "XREADGROUP",
                "GROUP",
                group,
                consumer,
                "COUNT",
                String(batchSize),
                "STREAMS",
                stream,
                ">",
            )) as [string, [string, string[]][]][] | null;
            if (!reply) break;
            let n = 0;
            for (const [, entries] of reply) {
                for (const [entryId, fields] of entries) {
                    await processEntry(entryId, fields, 1);
                    n++;
                }
            }
            total += n;
            if (n === 0) break;
        }
        return total;
    };

    return { start, stop, drainOnce, retryNow: () => retryPending(0) };
};

/**
 * Replay a stream from an entry id ("-" = beginning), outside any group.
 * The first page is inclusive of fromId; later pages use exclusive cursors.
 */
export const replay = async (
    redis: RedisLike,
    stream: string,
    fromId: string,
    handler: (envelope: EventEnvelope, entryId: string) => Promise<void>,
    pageSize = 100,
): Promise<number> => {
    let start = fromId === "0" ? "-" : fromId;
    let count = 0;
    for (;;) {
        const page = (await redis.call("XRANGE", stream, start, "+", "COUNT", String(pageSize))) as [
            string,
            string[],
        ][];
        if (!page || page.length === 0) break;
        for (const [entryId, fields] of page) {
            const raw = parseEnvelopeFields(fields);
            if (raw == null) continue;
            const envelope = EventEnvelopeBase.parse(JSON.parse(raw));
            await handler(envelope, entryId);
            count++;
            start = `(${entryId}`; // exclusive from here on
        }
        if (page.length < pageSize) break;
    }
    return count;
};

export interface LagReport {
    stream: string;
    group: string;
    streamLength: number;
    pending: number;
    lastDeliveredId: string | null;
}

export const groupLag = async (redis: RedisLike, stream: string, group: string): Promise<LagReport> => {
    const streamLength = (await redis.call("XLEN", stream).catch(() => 0)) as number;
    let pending = 0;
    let lastDeliveredId: string | null = null;
    try {
        const groups = (await redis.call("XINFO", "GROUPS", stream)) as unknown[][];
        for (const g of groups) {
            const map = new Map<string, unknown>();
            for (let i = 0; i < g.length - 1; i += 2) map.set(String(g[i]), g[i + 1]);
            if (map.get("name") === group) {
                pending = Number(map.get("pending") ?? 0);
                lastDeliveredId = String(map.get("last-delivered-id") ?? "") || null;
            }
        }
    } catch {
        // stream or group does not exist yet — report zeros
    }
    return { stream, group, streamLength, pending, lastDeliveredId };
};
