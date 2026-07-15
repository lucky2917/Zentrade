import { z } from "zod";
import { defineEvent } from "../envelope/envelope.js";

/**
 * knowledge.document.ingested v1 — a document entered the immutable corpus
 * (M17). One event per stored document. Re-ingesting identical content is
 * idempotent and emits nothing. The corpus is measurement only: nothing on
 * the decision path consumes knowledge yet.
 *
 * The payload reports facts about the stored observation — its identity, the
 * semantics that produced it, its license, and its shape. license is reported
 * as the already-validated string (the allowlist lives in the knowledge domain
 * and the database CHECK; contracts stays dependency-free).
 */
export const KnowledgeDocumentIngestedPayloadV1 = z.strictObject({
    documentId: z.uuid(),
    documentKey: z.string().length(64),
    knowledgeSemantics: z.string().min(1).max(32),
    license: z.string().min(1).max(48),
    contentSha256: z.string().length(64),
    charLen: z.int().nonnegative(),
    chunkCount: z.int().nonnegative(),
});
export type KnowledgeDocumentIngestedPayloadV1 = z.infer<typeof KnowledgeDocumentIngestedPayloadV1>;

export const KnowledgeDocumentIngestedV1 = defineEvent(
    "knowledge.document.ingested",
    1,
    KnowledgeDocumentIngestedPayloadV1,
);
export const KNOWLEDGE_DOCUMENT_INGESTED = { type: "knowledge.document.ingested", v: 1 } as const;
