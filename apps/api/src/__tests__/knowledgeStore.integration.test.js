import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildDocument } from "@zentrade/domain-knowledge";
import { sha256Hex } from "@zentrade/kernel";

/**
 * Knowledge store integration (M17): real Postgres + real Redis.
 * The corpus is append-only, so assertions are delta-based and every test
 * ingests uniquely-keyed content to stay isolated on a warm database.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const nonce = () => Math.random().toString(36).slice(2);

const doc = (overrides = {}) => ({
    sourceUri: `https://sebi.gov.in/report/${nonce()}`,
    rawContent: "Opening paragraph of the filing.\n\nSecond paragraph with additional detail and figures.",
    title: "Quarterly Filing",
    license: "public-domain",
    contentType: "text/plain",
    retrievedAt: "2026-07-16T10:00:00.000Z",
    ...overrides,
});

describe.skipIf(!TEST_DB || !TEST_REDIS)("knowledge store (integration)", () => {
    let pool, redis, store;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        redis = (await import("../config/redis.js")).default;
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        const { seedReferenceData } = await import("../services/referenceData.js");
        await seedReferenceData();
        store = await import("../services/knowledgeStore.js");
    }, 60_000);

    afterAll(async () => {
        await pool.end();
        redis.disconnect();
    });

    const counts = async () => ({
        documents: (await pool.query("SELECT COUNT(*)::int AS n FROM knowledge_documents")).rows[0].n,
        chunks: (await pool.query("SELECT COUNT(*)::int AS n FROM knowledge_chunks")).rows[0].n,
        events: (await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE event_type = 'knowledge.document.ingested'"))
            .rows[0].n,
    });

    it("ingests a document with its chunks and exactly one event", async () => {
        const before = await counts();
        const result = await store.ingestDocument(doc());
        expect(result.deduped).toBe(false);
        expect(result.chunkCount).toBeGreaterThanOrEqual(1);

        const after = await counts();
        expect(after.documents - before.documents).toBe(1);
        expect(after.chunks - before.chunks).toBe(result.chunkCount);
        expect(after.events - before.events).toBe(1);
    });

    it("is idempotent: re-ingesting identical content writes nothing", async () => {
        const input = doc();
        const first = await store.ingestDocument(input);
        const before = await counts();
        const second = await store.ingestDocument(input);
        const after = await counts();

        expect(second.deduped).toBe(true);
        expect(second.documentKey).toBe(first.documentKey);
        expect(after.documents - before.documents).toBe(0);
        expect(after.chunks - before.chunks).toBe(0);
        expect(after.events - before.events).toBe(0);
    });

    it("read projects full lineage and regenerates chunk text from offsets", async () => {
        const input = doc();
        const { documentKey } = await store.ingestDocument(input);
        const projected = await store.getDocument(documentKey);

        expect(projected.license).toBe("public-domain");
        expect(projected.sourceUri).toBe(input.sourceUri);
        expect(projected.knowledgeSemantics).toBe("knowledge_v1");
        for (const chunk of projected.chunks) {
            expect(sha256Hex(chunk.text)).toBe(chunk.textSha256);
        }
    });

    it("replays: rebuilding from stored content reproduces every chunk key", async () => {
        const input = doc();
        const { documentKey } = await store.ingestDocument(input);
        const projected = await store.getDocument(documentKey);
        const rebuilt = buildDocument({ ...input, maxChars: 500_000 });

        expect(rebuilt.documentKey).toBe(documentKey);
        expect(projected.chunks.map((c) => c.chunkKey)).toEqual(rebuilt.chunks.map((c) => c.chunkKey));
    });

    it("rejects an unpermitted license before touching the database", async () => {
        const before = await counts();
        await expect(store.ingestDocument(doc({ license: "gpl-3.0" }))).rejects.toMatchObject({
            code: "license_not_allowed",
        });
        expect((await counts()).documents - before.documents).toBe(0);
    });

    it("rejects content over the configured size limit before chunking", async () => {
        const before = await counts();
        const previous = process.env.KNOWLEDGE_MAX_CHARS;
        process.env.KNOWLEDGE_MAX_CHARS = "40";
        try {
            await expect(store.ingestDocument(doc({ rawContent: "y".repeat(200) }))).rejects.toMatchObject({
                code: "content_too_large",
            });
        } finally {
            if (previous === undefined) delete process.env.KNOWLEDGE_MAX_CHARS;
            else process.env.KNOWLEDGE_MAX_CHARS = previous;
        }
        expect((await counts()).documents - before.documents).toBe(0);
    });

    it("the database refuses an unpermitted license (allowlist CHECK)", async () => {
        await expect(
            pool.query(
                `INSERT INTO knowledge_documents
                   (document_key, knowledge_semantics, source_uri, content_sha256, title, license,
                    content_type, normalized_text, char_len, byte_len, chunk_count, retrieved_at)
                 VALUES ($1, 'knowledge_v1', 'x', $2, 't', 'proprietary', 'text/plain', 'body', 4, 4, 1, NOW())`,
                ["a".repeat(64), "b".repeat(64)]
            )
        ).rejects.toThrow(/check/i);
    });

    it("enforces referential integrity for chunks and instruments", async () => {
        await expect(
            store.ingestDocument(doc({ instrumentId: "00000000-0000-4000-8000-000000000000" }))
        ).rejects.toThrow(/foreign key|violates/i);
        await expect(
            pool.query(
                `INSERT INTO knowledge_chunks (chunk_key, document_id, ordinal, char_start, char_end, text_sha256)
                 VALUES ($1, '00000000-0000-4000-8000-000000000000', 0, 0, 1, $2)`,
                ["c".repeat(64), "d".repeat(64)]
            )
        ).rejects.toThrow(/foreign key|violates/i);
    });

    it("corpus is append-only", async () => {
        await expect(pool.query("UPDATE knowledge_documents SET title = 'x'")).rejects.toThrow(/append-only/);
        await expect(pool.query("UPDATE knowledge_chunks SET ordinal = 99")).rejects.toThrow(/append-only/);
        await expect(pool.query("DELETE FROM knowledge_chunks")).rejects.toThrow(/append-only/);
        await expect(pool.query("TRUNCATE knowledge_documents CASCADE")).rejects.toThrow(/append-only/);
    });

    it("nothing on the decision path reads the knowledge tables", async () => {
        const { execSync } = await import("node:child_process");
        const hits = execSync(
            "grep -rl 'knowledge_documents\\|knowledge_chunks' src/services/aiEngine.js src/services/decisionJournal.js src/routes/ai.js 2>/dev/null || true",
            { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8" }
        ).trim();
        expect(hits).toBe("");
    });
});
