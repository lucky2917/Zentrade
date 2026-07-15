import { buildDocument } from "@zentrade/domain-knowledge";
import { KNOWLEDGE_DOCUMENT_INGESTED } from "@zentrade/contracts";
import { metrics } from "@zentrade/observability";
import { pool } from "../config/db.js";
import { enqueueEvent } from "./eventBackbone.js";
import logger from "../utils/logger.js";

/**
 * Knowledge Store (M17) — ingestion adapter for the immutable corpus.
 *
 * The pure domain validates the license, enforces the size limit before any
 * chunking, normalizes, fingerprints, and chunks. This adapter persists the
 * result append-only and emits one event per stored document. Ingestion is
 * idempotent: re-ingesting identical content resolves to the existing
 * document_key and writes nothing. Nothing on the decision path reads here.
 *
 * Chunk TEXT is never stored — only offsets and hashes. The read side
 * regenerates chunk text by slicing the stored normalized document.
 */

const DEFAULT_MAX_CHARS = 500_000;

const maxChars = () => {
    const configured = Number(process.env.KNOWLEDGE_MAX_CHARS);
    return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_MAX_CHARS;
};

const insertChunks = async (client, documentId, chunks) => {
    const params = [documentId];
    const rows = chunks.map((chunk) => {
        const base = params.length;
        params.push(chunk.chunkKey, chunk.ordinal, chunk.charStart, chunk.charEnd, chunk.textSha256);
        return `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    });
    await client.query(
        `INSERT INTO knowledge_chunks (document_id, chunk_key, ordinal, char_start, char_end, text_sha256)
         VALUES ${rows.join(", ")}`,
        params
    );
};

export const ingestDocument = async (input) => {
    const started = performance.now();
    const built = buildDocument({ ...input, maxChars: maxChars() });

    const { rows: existingRows } = await pool.query(
        "SELECT id, chunk_count FROM knowledge_documents WHERE document_key = $1",
        [built.documentKey]
    );
    const existing = existingRows[0];
    if (existing) {
        return { documentId: existing.id, documentKey: built.documentKey, chunkCount: existing.chunk_count, deduped: true };
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const {
            rows: [document],
        } = await client.query(
            `INSERT INTO knowledge_documents
               (document_key, knowledge_semantics, source_uri, content_sha256, title, publisher,
                license, content_type, normalized_text, char_len, byte_len, chunk_count,
                instrument_id, published_at, retrieved_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             RETURNING id`,
            [
                built.documentKey,
                built.knowledgeSemantics,
                built.sourceUri,
                built.contentSha256,
                built.title,
                built.publisher,
                built.license,
                built.contentType,
                built.normalizedText,
                built.charLen,
                built.byteLen,
                built.chunks.length,
                built.instrumentId,
                built.publishedAt,
                built.retrievedAt,
            ]
        );
        await insertChunks(client, document.id, built.chunks);
        await enqueueEvent(
            {
                type: KNOWLEDGE_DOCUMENT_INGESTED.type,
                v: KNOWLEDGE_DOCUMENT_INGESTED.v,
                payload: {
                    documentId: document.id,
                    documentKey: built.documentKey,
                    knowledgeSemantics: built.knowledgeSemantics,
                    license: built.license,
                    contentSha256: built.contentSha256,
                    charLen: built.charLen,
                    chunkCount: built.chunks.length,
                },
            },
            client
        );
        await client.query("COMMIT");
        metrics.counter("knowledge.documents").inc();
        metrics.gauge("knowledge.last_ingest_ms").set(Math.round(performance.now() - started));
        logger.info("KnowledgeStore", "document ingested", {
            documentId: document.id,
            documentKey: built.documentKey,
            chunks: built.chunks.length,
        });
        return { documentId: document.id, documentKey: built.documentKey, chunkCount: built.chunks.length, deduped: false };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
};

const documentProjection = (row) => ({
    documentId: row.id,
    documentKey: row.document_key,
    knowledgeSemantics: row.knowledge_semantics,
    sourceUri: row.source_uri,
    contentSha256: row.content_sha256,
    title: row.title,
    publisher: row.publisher,
    license: row.license,
    contentType: row.content_type,
    charLen: row.char_len,
    byteLen: row.byte_len,
    chunkCount: row.chunk_count,
    instrumentId: row.instrument_id,
    publishedAt: row.published_at,
    retrievedAt: row.retrieved_at,
    ingestedAt: row.ingested_at,
});

export const listDocuments = async ({ limit, cursor }) => {
    const params = [];
    const where = [];
    if (cursor) {
        params.push(cursor.ingestedAt, cursor.id);
        where.push(`(ingested_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const { rows } = await pool.query(
        `SELECT id, document_key, knowledge_semantics, source_uri, content_sha256, title, publisher,
                license, content_type, char_len, byte_len, chunk_count, instrument_id,
                published_at, retrieved_at, ingested_at
         FROM knowledge_documents
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY ingested_at DESC, id DESC
         LIMIT $${params.length}`,
        params
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
        documents: page.map(documentProjection),
        hasMore,
        next: hasMore && last ? { ingestedAt: last.ingested_at, id: last.id } : null,
    };
};

export const getDocument = async (documentKey) => {
    const {
        rows: [document],
    } = await pool.query("SELECT * FROM knowledge_documents WHERE document_key = $1", [documentKey]);
    if (!document) return null;
    const { rows: chunks } = await pool.query(
        `SELECT chunk_key, ordinal, char_start, char_end, text_sha256
         FROM knowledge_chunks WHERE document_id = $1 ORDER BY ordinal`,
        [document.id]
    );
    return {
        ...documentProjection(document),
        chunks: chunks.map((chunk) => ({
            chunkKey: chunk.chunk_key,
            ordinal: chunk.ordinal,
            charStart: chunk.char_start,
            charEnd: chunk.char_end,
            textSha256: chunk.text_sha256,
            text: document.normalized_text.slice(chunk.char_start, chunk.char_end),
        })),
    };
};
