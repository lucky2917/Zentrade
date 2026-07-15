import { sha256Hex } from "@zentrade/kernel";
import { isAllowedLicense, type KnowledgeLicense } from "./license.js";
import { normalizeContent } from "./normalize.js";
import { documentKey } from "./identity.js";
import { chunkDocument, type BuiltChunk } from "./chunk.js";

/**
 * Knowledge assembly (M17) — semantics `knowledge_v1`. Pure and deterministic:
 * identical input always yields identical identity, offsets, and hashes.
 *
 * A document is validated, normalized, fingerprinted, and chunked in one pass.
 * Validation fails closed: an unknown license or an oversized document is
 * rejected before any chunking work is done. knowledge_semantics is stamped
 * on the result so a future normalization or chunking (knowledge_v2, ...)
 * coexists with, and never reinterprets, what was stored under v1.
 */

export const KNOWLEDGE_SEMANTICS = "knowledge_v1" as const;

export type KnowledgeErrorCode = "missing_field" | "license_not_allowed" | "empty_content" | "content_too_large";

export class KnowledgeValidationError extends Error {
    readonly code: KnowledgeErrorCode;
    constructor(code: KnowledgeErrorCode, message: string) {
        super(message);
        this.name = "KnowledgeValidationError";
        this.code = code;
    }
}

export interface DocumentInput {
    sourceUri: string;
    rawContent: string;
    title: string;
    license: string;
    contentType: string;
    retrievedAt: string;
    maxChars: number;
    publisher?: string | null;
    publishedAt?: string | null;
    instrumentId?: string | null;
}

export interface BuiltDocument {
    documentKey: string;
    knowledgeSemantics: typeof KNOWLEDGE_SEMANTICS;
    sourceUri: string;
    contentSha256: string;
    normalizedText: string;
    charLen: number;
    byteLen: number;
    title: string;
    license: KnowledgeLicense;
    contentType: string;
    publisher: string | null;
    publishedAt: string | null;
    instrumentId: string | null;
    retrievedAt: string;
    chunks: BuiltChunk[];
}

const requireField = (field: string, value: unknown): string => {
    if (typeof value !== "string" || value.trim() === "") {
        throw new KnowledgeValidationError("missing_field", `missing ${field}`);
    }
    return value;
};

export const buildDocument = (input: DocumentInput): BuiltDocument => {
    requireField("sourceUri", input.sourceUri);
    requireField("title", input.title);
    requireField("contentType", input.contentType);
    requireField("retrievedAt", input.retrievedAt);

    if (!isAllowedLicense(input.license)) {
        throw new KnowledgeValidationError("license_not_allowed", `license not permitted: ${input.license}`);
    }
    if (!Number.isInteger(input.maxChars) || input.maxChars <= 0) {
        throw new KnowledgeValidationError("missing_field", "maxChars must be a positive integer");
    }

    const normalizedText = normalizeContent(input.rawContent ?? "");
    if (normalizedText.length === 0) {
        throw new KnowledgeValidationError("empty_content", "document has no content after normalization");
    }
    if (normalizedText.length > input.maxChars) {
        throw new KnowledgeValidationError(
            "content_too_large",
            `normalized content ${normalizedText.length} exceeds limit ${input.maxChars}`,
        );
    }

    const contentSha256 = sha256Hex(normalizedText);
    const docKey = documentKey(input.sourceUri, contentSha256);

    return {
        documentKey: docKey,
        knowledgeSemantics: KNOWLEDGE_SEMANTICS,
        sourceUri: input.sourceUri,
        contentSha256,
        normalizedText,
        charLen: normalizedText.length,
        byteLen: Buffer.byteLength(normalizedText, "utf8"),
        title: input.title,
        license: input.license,
        contentType: input.contentType,
        publisher: input.publisher ?? null,
        publishedAt: input.publishedAt ?? null,
        instrumentId: input.instrumentId ?? null,
        retrievedAt: input.retrievedAt,
        chunks: chunkDocument(normalizedText, docKey),
    };
};
