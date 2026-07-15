import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Memory indexer integration (M14): real Postgres + real Redis.
 * Append-only house rule: memories accumulate across runs, so assertions
 * are convergence- and delta-based, never absolute counts.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const HASH_M = "e".repeat(64);

const journalFixture = () => ({
    symbol: "TCS",
    trigger: "test",
    contextSnapshot: { price: 4100, changePercent: -0.4, priceTimestamp: 1783929474262, marketOpen: false, inputsHash: HASH_M },
    evidence: [{ ref: "price:live", kind: "price", sourceRef: "test", content: { price: 4100 }, weight: null }],
    runs: ["technical", "sentiment", "risk", "synthesizer"].map((agentName) => ({
        agentName,
        agentVersion: "v4.0.0",
        modelId: "llama-3.3-70b-versatile",
        inputHash: HASH_M,
        output: { signal: agentName === "sentiment" ? "BEARISH" : "BULLISH", confidence: "MEDIUM", keyPoints: ["k1", "k2"] },
        status: "ok",
        latencyMs: 500,
        promptTokens: 800,
        completionTokens: 100,
        costUsd: 0.0005,
    })),
    decision: {
        action: "SELL",
        mode: "INTRADAY",
        confidence: "HIGH",
        entryMinor: 410000,
        targetMinor: 405900,
        stopMinor: 412050,
        rationale: { traderNote: "note", reasoning: ["r1"], consensus: "majority", macroScore: 0 },
        synthesizerVersion: "v4.0.0",
    },
});

describe.skipIf(!TEST_DB || !TEST_REDIS)("memory indexer (integration)", () => {
    let pool, redis, indexer, decisionId;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        redis = (await import("../config/redis.js")).default;
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        const { seedReferenceData } = await import("../services/referenceData.js");
        await seedReferenceData();
        indexer = await import("../services/memoryIndexer.js");

        const journal = await import("../services/decisionJournal.js");
        ({ decisionId } = await journal.journalAnalysis(journalFixture()));
        await pool.query(
            `INSERT INTO outcomes (decision_id, horizon, basis, hit, entry_minor, exit_minor, realized_return_bps, sessions_used, data_source)
             VALUES ($1, 'intraday', 'squareoff', 'stop', 410000, 412050, -50, 1, 'test')`,
            [decisionId]
        );
    }, 60_000);

    afterAll(async () => {
        await pool.end();
        redis.disconnect();
    });

    it("forms an episode for every labeled outcome, idempotently, with events", async () => {
        const unindexedBefore = (
            await pool.query(
                "SELECT COUNT(*)::int AS n FROM outcomes o LEFT JOIN memories m ON m.outcome_id = o.id WHERE m.id IS NULL"
            )
        ).rows[0].n;
        const eventsBefore = (await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE event_type = 'mem.episode.formed'")).rows[0].n;

        const started = performance.now();
        const first = await indexer.formEpisodes();
        const elapsed = performance.now() - started;

        expect(first.formed).toBe(unindexedBefore); // convergence: everything unindexed, exactly once
        expect(first.formed).toBeGreaterThanOrEqual(1);
        expect(elapsed / first.formed).toBeLessThan(50); // low write latency: <50ms per episode

        const second = await indexer.formEpisodes();
        expect(second.formed).toBe(0); // idempotent

        const remaining = (
            await pool.query(
                "SELECT COUNT(*)::int AS n FROM outcomes o LEFT JOIN memories m ON m.outcome_id = o.id WHERE m.id IS NULL"
            )
        ).rows[0].n;
        expect(remaining).toBe(0);

        const eventsAfter = (await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE event_type = 'mem.episode.formed'")).rows[0].n;
        expect(eventsAfter - eventsBefore).toBe(first.formed);
    });

    it("episodes reference the journal, they never duplicate it", async () => {
        const { rows: cols } = await pool.query(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'memories'"
        );
        const names = cols.map((c) => c.column_name);
        // structural law: no agent text, no evidence content, no snapshots
        for (const forbidden of ["output", "content", "context_snapshot", "rationale", "narrative"]) {
            expect(names).not.toContain(forbidden);
        }

        // every reference resolves back to the single source of truth
        const { rows } = await pool.query(
            `SELECT m.symbol AS m_symbol, i.symbol AS i_symbol, m.action AS m_action, d.action AS d_action,
                    m.hit AS m_hit, o.hit AS o_hit
             FROM memories m
             JOIN decisions d ON d.id = m.decision_id
             JOIN instruments i ON i.id = m.instrument_id
             JOIN outcomes o ON o.id = m.outcome_id
             WHERE m.decision_id = $1`,
            [decisionId]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].m_symbol).toBe(rows[0].i_symbol);
        expect(rows[0].m_action).toBe(rows[0].d_action);
        expect(rows[0].m_hit).toBe(rows[0].o_hit);
    });

    it("memory identity is the deterministic episode key, unique forever", async () => {
        const { episodeKey } = await import("@zentrade/domain-memory");
        const { rows } = await pool.query("SELECT memory_key, horizon FROM memories WHERE decision_id = $1", [decisionId]);
        expect(rows[0].memory_key).toBe(episodeKey(decisionId, rows[0].horizon));

        await expect(
            pool.query(
                `INSERT INTO memories (memory_key, semantics, decision_id, request_id, outcome_id, instrument_id,
                                       horizon, symbol, venue, action, mode, confidence, regime, hit, basis, decision_date)
                 SELECT memory_key, semantics, decision_id, request_id, outcome_id, instrument_id,
                        horizon, symbol, venue, action, mode, confidence, regime, hit, basis, decision_date
                 FROM memories WHERE decision_id = $1`,
                [decisionId]
            )
        ).rejects.toThrow(/duplicate key/);
    });

    it("memories are append-only: the brain cannot rewrite what it experienced", async () => {
        await expect(pool.query("UPDATE memories SET hit = 'target' WHERE decision_id = $1", [decisionId])).rejects.toThrow(/append-only/);
        await expect(pool.query("DELETE FROM memories")).rejects.toThrow(/append-only/);
        await expect(pool.query("TRUNCATE memories")).rejects.toThrow(/append-only/);
    });

    it("retrieval readiness: the planner uses the (symbol, date) index, not a seq scan", async () => {
        await pool.query("SET enable_seqscan = off");
        const { rows } = await pool.query(
            "EXPLAIN SELECT * FROM memories WHERE symbol = 'TCS' ORDER BY decision_date DESC LIMIT 10"
        );
        await pool.query("SET enable_seqscan = on");
        expect(rows.map((r) => r["QUERY PLAN"]).join("\n")).toMatch(/idx_memories_symbol_date/);
    });

    it("nothing on the decision path reads memories (indexing, not influence yet)", async () => {
        const { execSync } = await import("node:child_process");
        const hits = execSync(
            "grep -rl 'FROM memories' src/services/aiEngine.js src/services/decisionJournal.js src/routes/ 2>/dev/null || true",
            { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8" }
        ).trim();
        expect(hits).toBe("");
    });
});
