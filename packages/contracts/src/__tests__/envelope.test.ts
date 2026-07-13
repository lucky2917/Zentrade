import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineEvent, EventEnvelopeBase, EVENT_TYPE_PATTERN } from "../index.js";

const CandleClosed = defineEvent(
    "md.candle.closed",
    1,
    z.strictObject({ symbol: z.string(), close: z.number().positive() }),
);

const valid = {
    id: "3b241101-e2bb-4255-8caf-4136c566a962",
    type: "md.candle.closed",
    v: 1,
    occurredAt: "2026-07-13T10:00:00.000Z",
    source: "ingest-worker",
    correlationId: "9f8b1c62-1a2b-4c3d-8e4f-5a6b7c8d9e0f",
    causationId: null,
    payload: { symbol: "RELIANCE", close: 1518.4 },
};

describe("EventEnvelope / defineEvent", () => {
    it("accepts a fully-formed event", () => {
        expect(CandleClosed.parse(valid)).toEqual(valid);
    });

    it("pins type and v as literals", () => {
        expect(CandleClosed.safeParse({ ...valid, type: "md.tick" }).success).toBe(false);
        expect(CandleClosed.safeParse({ ...valid, v: 2 }).success).toBe(false);
    });

    it("validates the payload with the event's own schema", () => {
        expect(CandleClosed.safeParse({ ...valid, payload: { symbol: "X", close: -1 } }).success).toBe(false);
        expect(CandleClosed.safeParse({ ...valid, payload: { symbol: "X", close: 1, extra: 1 } }).success).toBe(false);
    });

    it("rejects malformed ids, timestamps and unknown envelope keys", () => {
        expect(CandleClosed.safeParse({ ...valid, id: "not-a-uuid" }).success).toBe(false);
        expect(CandleClosed.safeParse({ ...valid, occurredAt: "yesterday" }).success).toBe(false);
        expect(CandleClosed.safeParse({ ...valid, smuggled: true }).success).toBe(false);
    });

    it("causationId may be null (root events) but must be a uuid otherwise", () => {
        expect(CandleClosed.safeParse({ ...valid, causationId: "nope" }).success).toBe(false);
        expect(
            CandleClosed.safeParse({ ...valid, causationId: "3b241101-e2bb-4255-8caf-4136c566a962" }).success,
        ).toBe(true);
    });

    it("factory refuses malformed event type names at definition time", () => {
        expect(() => defineEvent("BadType", 1, z.unknown())).toThrow();
        expect(() => defineEvent("single", 1, z.unknown())).toThrow();
        expect(EVENT_TYPE_PATTERN.test("intel.decision.published")).toBe(true);
    });

    it("base envelope enforces the type grammar", () => {
        expect(EventEnvelopeBase.safeParse({ ...valid, type: "Not.Valid.CAPS" }).success).toBe(false);
    });
});
