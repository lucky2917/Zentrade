import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

/**
 * Correlation context — one id follows a piece of work across await points,
 * HTTP handlers, outbox writes and stream consumers. The logger attaches it
 * automatically; enqueueEvent reads it as the envelope's correlationId.
 */

const storage = new AsyncLocalStorage<string>();

export const runWithCorrelation = <T>(correlationId: string, fn: () => T): T =>
    storage.run(correlationId, fn);

export const currentCorrelationId = (): string | undefined => storage.getStore();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accept a caller-supplied id only if it is a well-formed uuid; else mint one. */
export const ensureCorrelationId = (candidate: unknown): string =>
    typeof candidate === "string" && UUID_RE.test(candidate) ? candidate.toLowerCase() : randomUUID();
