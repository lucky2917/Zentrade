/**
 * @zentrade/eventbus — durable eventing over Redis Streams.
 *
 * Rules of this package (constitutional):
 *  1. Envelopes are validated at publish and at consume (contracts schemas).
 *  2. At-least-once delivery; consumers must be idempotent (dedupe on id).
 *  3. Poison messages dead-letter after maxDeliveries; nothing blocks forever.
 *  4. The public surface mirrors JetStream semantics (stream/subject, durable
 *     group, ack, replay) — swapping the transport is an adapter change.
 */

export {
    createPublisher,
    createConsumer,
    replay,
    groupLag,
    streamNameFor,
    DLQ_STREAM,
    type RedisLike,
    type EventEnvelope,
    type BusOptions,
    type ConsumerOptions,
    type PublishResult,
    type LagReport,
} from "./bus.js";

export { createEnvelope, type CreateEnvelopeInput } from "./envelope.js";
