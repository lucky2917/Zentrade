import { randomUUID } from "node:crypto";
import { EventEnvelopeBase } from "@zentrade/contracts";
import type { EventEnvelope } from "./bus.js";

export interface CreateEnvelopeInput {
    type: string;
    v: number;
    source: string;
    payload: unknown;
    correlationId?: string;
    causationId?: string | null;
    occurredAt?: Date;
}

/** Build and validate a fresh envelope. Root events get their own correlationId. */
export const createEnvelope = (input: CreateEnvelopeInput): EventEnvelope =>
    EventEnvelopeBase.parse({
        id: randomUUID(),
        type: input.type,
        v: input.v,
        occurredAt: (input.occurredAt ?? new Date()).toISOString(),
        source: input.source,
        correlationId: input.correlationId ?? randomUUID(),
        causationId: input.causationId ?? null,
        payload: input.payload,
    });
