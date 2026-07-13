import { z } from "zod";

/**
 * Event envelope — every event on the backbone wears this, no exceptions.
 *
 * VERSIONING POLICY (constitutional, append-only):
 *  - `type` is a dot-separated lowercase name, e.g. "md.candle.closed".
 *  - `v` is the payload schema version. Payload changes that are not purely
 *    additive-and-optional REQUIRE a new `v`; both versions stay defined here
 *    and consumers migrate at their own pace. Schemas are never edited in
 *    place to mean something different — old events must parse forever.
 *  - Envelopes reject unknown keys (strict) so drift is caught at the edge.
 *
 *  - `correlationId` groups everything caused by one user request / pipeline
 *    run; `causationId` is the id of the event that directly caused this one
 *    (null for roots). Together they make lineage replayable.
 */

export const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

export const EventEnvelopeBase = z.strictObject({
    id: z.uuid(),
    type: z.string().regex(EVENT_TYPE_PATTERN, "dot-separated lowercase event type"),
    v: z.int().positive(),
    occurredAt: z.iso.datetime(),
    source: z.string().min(1).max(64),
    correlationId: z.uuid(),
    causationId: z.uuid().nullable(),
    payload: z.unknown(),
});
export type EventEnvelopeBase = z.infer<typeof EventEnvelopeBase>;

/**
 * Factory for concrete event schemas: pins `type` and `v` as literals and
 * types the payload. All events on the backbone are defined through this.
 */
export const defineEvent = <TType extends string, TPayload extends z.ZodType>(
    type: TType,
    v: number,
    payload: TPayload,
) => {
    if (!EVENT_TYPE_PATTERN.test(type)) {
        throw new Error(`invalid event type "${type}"`);
    }
    return EventEnvelopeBase.omit({ type: true, v: true, payload: true }).extend({
        type: z.literal(type),
        v: z.literal(v),
        payload,
    });
};
