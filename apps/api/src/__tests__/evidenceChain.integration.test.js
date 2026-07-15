import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Evidence Chain integration (M8): real Postgres + real Redis.
 * Observations (evidence) and interpretation (runs) stay structurally
 * separate; decisions cannot exist without evidence — enforced by the
 * DATABASE, not by politeness.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const HASH_A = "b".repeat(64);

const run = (agentName, citationReport = null, status = "ok") => ({
    agentName,
    agentVersion: "v4.1.0",
    modelId: "llama-3.3-70b-versatile",
    inputHash: HASH_A,
    output: { signal: "BULLISH", keyPoints: [{ point: "RSI supportive", refs: ["ind:rsi14"] }] },
    status,
    latencyMs: 500,
    promptTokens: 900,
    completionTokens: 100,
    costUsd: 0.00061,
    citationReport,
});

const evidence = () => [
    { ref: "price:live", kind: "price", sourceRef: "redis:stock-cache", content: { price: 1518.4 }, weight: null },
    { ref: "ind:rsi14", kind: "indicator", sourceRef: "fyers:candles:D:365", content: { rsi14: 61.2 }, weight: null },
    { ref: "macro:nifty", kind: "macro", sourceRef: "fyers:candles:index:D", content: { changePercent: 0.8 }, weight: null },
    { ref: "news:1", kind: "news", sourceRef: "finnhub:company-news", content: { headline: "<img src=x>", source: "wire" }, weight: null },
];

const decision = () => ({
    action: "BUY",
    mode: "INTRADAY",
    confidence: "MEDIUM",
    entryMinor: 151800,
    targetMinor: 153650,
    stopMinor: 151050,
    rationale: { traderNote: "note", reasoning: ["r1"], consensus: "majority", macroScore: 0 },
    synthesizerVersion: "v4.1.0",
});

const input = (overrides = {}) => ({
    symbol: "TCS",
    trigger: "test",
    contextSnapshot: { price: 4123.5, changePercent: 0.4, priceTimestamp: 1783929474262, marketOpen: false, inputsHash: HASH_A },
    evidence: evidence(),
    runs: [run("technical"), run("sentiment", { status: "invalid", uncitedCount: 1, unknownRefs: [] }, "invalid")],
    decision: decision(),
    ...overrides,
});

describe.skipIf(!TEST_DB || !TEST_REDIS)("evidence chain (integration)", () => {
    let pool, redis, journal;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        redis = (await import("../config/redis.js")).default;
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        const { seedReferenceData } = await import("../services/referenceData.js");
        await seedReferenceData();
        journal = await import("../services/decisionJournal.js");
    });

    afterAll(async () => {
        await pool.end();
        redis.disconnect();
    });

    it("stores the bundle once per request with kinds, unique refs and returned ids", async () => {
        const { requestId, evidenceIds } = await journal.journalAnalysis(input());
        expect(evidenceIds).toHaveLength(4);

        const { rows } = await pool.query(
            "SELECT ref, kind, source_ref, content FROM evidence WHERE request_id = $1 ORDER BY ref",
            [requestId]
        );
        expect(rows.map((r) => `${r.kind}:${r.ref}`)).toEqual([
            "indicator:ind:rsi14",
            "macro:macro:nifty",
            "news:news:1",
            "price:price:live",
        ]);
        // news stored raw-as-observed (renderers escape; storage never mutates)
        expect(rows.find((r) => r.ref === "news:1").content.headline).toBe("<img src=x>");
    });

    it("the published event carries the evidence row ids", async () => {
        const { decisionId, evidenceIds } = await journal.journalAnalysis(input());
        const { rows } = await pool.query(
            "SELECT payload FROM outbox WHERE event_type = 'intel.decision.published' AND payload->'payload'->>'decisionId' = $1",
            [decisionId]
        );
        expect(rows[0].payload.payload.evidenceIds).toEqual(evidenceIds);
    });

    it("citation verdicts persist on runs, including invalid status", async () => {
        const { requestId } = await journal.journalAnalysis(input());
        const { rows } = await pool.query(
            "SELECT agent_name, status, citation_report FROM agent_runs WHERE request_id = $1 ORDER BY agent_name",
            [requestId]
        );
        expect(rows).toEqual([
            { agent_name: "sentiment", status: "invalid", citation_report: { status: "invalid", uncitedCount: 1, unknownRefs: [] } },
            { agent_name: "technical", status: "ok", citation_report: null },
        ]);
    });

    it("DATABASE LAW: a decision without evidence is rejected by trigger, not by convention", async () => {
        // craft a request with zero evidence directly, then try to attach a decision
        const inst = (await pool.query("SELECT id FROM instruments WHERE venue='NSE' AND symbol='TCS'")).rows[0];
        const req = (
            await pool.query(
                `INSERT INTO decision_requests (instrument_id, requested_by, correlation_id, context_snapshot)
                 VALUES ($1, 'test', gen_random_uuid(), '{}') RETURNING id`,
                [inst.id]
            )
        ).rows[0];

        await expect(
            pool.query(
                `INSERT INTO decisions (request_id, instrument_id, action, mode, confidence, rationale, synthesizer_version, correlation_id)
                 VALUES ($1, $2, 'BUY', 'INTRADAY', 'LOW', '{}', 'v0', gen_random_uuid())`,
                [req.id, inst.id]
            )
        ).rejects.toThrow(/no evidence rows exist/);
    });

    it("repository guard mirrors the trigger: decision + empty bundle fails BEFORE the tx", async () => {
        const before = (await pool.query("SELECT COUNT(*)::int AS n FROM decision_requests")).rows[0].n;
        await expect(journal.journalAnalysis(input({ evidence: [] }))).rejects.toThrow(/at least one evidence/);
        const after = (await pool.query("SELECT COUNT(*)::int AS n FROM decision_requests")).rows[0].n;
        expect(after).toBe(before); // nothing partially written
    });

    it("evidence is append-only: UPDATE, DELETE, TRUNCATE all rejected", async () => {
        const { requestId } = await journal.journalAnalysis(input());
        await expect(pool.query("UPDATE evidence SET content = '{}' WHERE request_id = $1", [requestId])).rejects.toThrow(/append-only/);
        await expect(pool.query("DELETE FROM evidence WHERE request_id = $1", [requestId])).rejects.toThrow(/append-only/);
        await expect(pool.query("TRUNCATE evidence")).rejects.toThrow(/append-only/);
    });

    it("duplicate refs within one request are impossible (bundle integrity)", async () => {
        const dup = evidence();
        dup.push({ ...dup[0] });
        await expect(journal.journalAnalysis(input({ evidence: dup }))).rejects.toThrow(/duplicate key|unique/i);
    });

    it("orphan evidence is impossible: inserting against a missing request fails FK", async () => {
        await expect(
            pool.query(
                `INSERT INTO evidence (request_id, ref, kind, source_ref, content) VALUES (gen_random_uuid(), 'x:y', 'price', 's', '{}')`
            )
        ).rejects.toThrow(/foreign key/);
    });
});
