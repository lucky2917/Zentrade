import { createPublisher, createConsumer, createEnvelope, groupLag, streamNameFor, DLQ_STREAM } from "@zentrade/eventbus";
import { MdCandleClosedV1, MD_CANDLE_CLOSED } from "@zentrade/contracts";
import redis from "../config/redis.js";
import { pool } from "../config/db.js";
import logger from "../utils/logger.js";

/**
 * Event backbone wiring for the api process (M4):
 *  - enqueueEvent(): write an envelope to the transactional outbox
 *  - relay loop:     outbox -> Redis Streams (at-least-once)
 *  - first consumer: no-op logger on md.candle.closed (proves the pipe)
 *
 * The existing price:update pub/sub is deliberately untouched.
 */

const RELAY_INTERVAL_MS = 500;
const RELAY_BATCH = 100;
const SOURCE = "api";

const publisher = createPublisher(redis);

let relayTimer = null;
let relayRunning = false;
let consumer = null;
let consumerClient = null;

/**
 * Enqueue an event into the outbox. Pass the caller's transaction client to
 * commit atomically with a state change; defaults to the pool (autocommit)
 * for producers that have no surrounding transaction.
 */
export const enqueueEvent = async ({ type, v, payload, correlationId, causationId }, client = pool) => {
    const envelope = createEnvelope({ type, v, source: SOURCE, payload, correlationId, causationId });
    await client.query(
        "INSERT INTO outbox (event_id, event_type, payload) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING",
        [envelope.id, envelope.type, JSON.stringify(envelope)]
    );
    return envelope;
};

/**
 * One relay pass: claim a batch of unpublished rows, publish to streams,
 * stamp published_at — all in one transaction. If Redis fails mid-batch the
 * transaction rolls back and the whole batch retries next tick (consumers
 * may see duplicates: at-least-once by design, dedupe on envelope id).
 */
export const relayOutboxOnce = async () => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query(
            "SELECT id, payload FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED",
            [RELAY_BATCH]
        );
        if (rows.length === 0) {
            await client.query("COMMIT");
            return 0;
        }

        for (const row of rows) {
            await publisher.publish(row.payload);
        }

        await client.query(
            "UPDATE outbox SET published_at = NOW() WHERE id = ANY($1::bigint[])",
            [rows.map((r) => r.id)]
        );
        await client.query("COMMIT");
        return rows.length;
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
};

let currentRelayPass = null;

const relayTick = () => {
    if (relayRunning) return currentRelayPass;
    relayRunning = true;
    currentRelayPass = (async () => {
        try {
            let published;
            do {
                published = await relayOutboxOnce();
            } while (published === RELAY_BATCH); // drain backlog without waiting a tick
        } catch (err) {
            logger.error("EventBackbone", "Relay pass failed, will retry", { error: err.message });
        } finally {
            relayRunning = false;
        }
    })();
    return currentRelayPass;
};

export const startEventBackbone = () => {
    relayTimer = setInterval(relayTick, RELAY_INTERVAL_MS);
    relayTick();

    // XREADGROUP blocks its connection — the consumer gets a dedicated one
    consumerClient = redis.duplicate();
    consumer = createConsumer(consumerClient, {
        stream: streamNameFor(MD_CANDLE_CLOSED.type),
        group: "loggers",
        consumer: `api-${process.pid}`,
        schema: MdCandleClosedV1,
        handler: async (envelope) => {
            const { symbol, resolution, candle } = envelope.payload;
            const lagMs = Date.now() - new Date(envelope.occurredAt).getTime();
            logger.info("EventBackbone", `candle.closed ${symbol} ${resolution} close=${candle.close}`, {
                eventId: envelope.id,
                lagMs,
            });
        },
        onError: (err, context) =>
            logger.error("EventBackbone", `consumer error: ${context}`, { error: String(err) }),
    });
    consumer.start();
    logger.info("EventBackbone", "Relay + candle.closed logger consumer started");
};

export const stopEventBackbone = async () => {
    if (relayTimer) clearInterval(relayTimer);
    // drain the in-flight relay pass before the pool closes under it —
    // an interrupted pass rolls back and republishes on next boot (harmless
    // but duplicate-producing; observed during M5 verification)
    if (currentRelayPass) await currentRelayPass.catch(() => {});
    if (consumer) await consumer.stop().catch(() => {});
    if (consumerClient) await consumerClient.quit().catch(() => {});
};

/** Ops view for /internal/eventbus/lag */
export const getBackboneLag = async () => {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS unpublished FROM outbox WHERE published_at IS NULL");
    const candleStream = await groupLag(redis, streamNameFor(MD_CANDLE_CLOSED.type), "loggers");
    const dlqLength = await redis.call("XLEN", DLQ_STREAM).catch(() => 0);
    return {
        outboxUnpublished: rows[0].unpublished,
        streams: [candleStream],
        dlqLength: Number(dlqLength),
    };
};
