import { describe, it, expect, beforeAll, afterAll } from "vitest";

/** Memory retrieval integration (M15): real Postgres + real Redis. */
const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const HASH_R = "9".repeat(64);

// journalFixture() writes decisions with created_at = NOW(); asOf must
// always be strictly after "today" for the eligibility window to include
// them, so it is computed relative to the clock instead of hardcoded.
const tomorrowIso = () => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + 2); // +2 clears IST/UTC date-boundary skew
    return d.toISOString().slice(0, 10);
};

const journalFixture = (action = "BUY") => ({
    symbol: "INFY",
    trigger: "test",
    contextSnapshot: { price: 1900, changePercent: 0.2, priceTimestamp: 1783929474262, marketOpen: false, inputsHash: HASH_R },
    evidence: [{ ref: "price:live", kind: "price", sourceRef: "test", content: { price: 1900 }, weight: null }],
    runs: ["technical", "sentiment", "risk", "synthesizer"].map((agentName) => ({
        agentName,
        agentVersion: "v4.0.0",
        modelId: "llama-3.3-70b-versatile",
        inputHash: HASH_R,
        output: { signal: "BULLISH", confidence: "MEDIUM", keyPoints: ["k1", "k2"] },
        status: "ok",
        latencyMs: 500,
        promptTokens: 800,
        completionTokens: 100,
        costUsd: 0.0005,
    })),
    decision: {
        action,
        mode: "INTRADAY",
        confidence: "MEDIUM",
        entryMinor: 190000,
        targetMinor: 191900,
        stopMinor: 189050,
        rationale: { traderNote: "note", reasoning: ["r1"], consensus: "majority", macroScore: 0 },
        synthesizerVersion: "v4.0.0",
    },
});

describe.skipIf(!TEST_DB || !TEST_REDIS)("memory retrieval (integration)", () => {
    let pool, redis, retrieval;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        redis = (await import("../config/redis.js")).default;
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        const { seedReferenceData } = await import("../services/referenceData.js");
        await seedReferenceData();
        retrieval = await import("../services/memoryRetrieval.js");

        const journal = await import("../services/decisionJournal.js");
        const indexer = await import("../services/memoryIndexer.js");
        for (const [action, hit, bps] of [["BUY", "target", 100], ["BUY", "stop", -50], ["SELL", "neither", 10]]) {
            const { decisionId } = await journal.journalAnalysis(journalFixture(action));
            await pool.query(
                `INSERT INTO outcomes (decision_id, horizon, basis, hit, entry_minor, exit_minor, realized_return_bps, sessions_used, data_source)
                 VALUES ($1, 'intraday', 'squareoff', $2, 190000, 191900, $3, 1, 'test')`,
                [decisionId, hit, bps]
            );
        }
        await indexer.formEpisodes();
    }, 60_000);

    afterAll(async () => {
        await pool.end();
        redis.disconnect();
    });

    it("retrieves ranked historical observations verbatim, with regenerated narratives", async () => {
        const tomorrow = tomorrowIso();
        const result = await retrieval.retrieveMemories({ symbol: "INFY", asOf: tomorrow });
        expect(result.semantics).toBe("retrieval_v1");
        expect(result.memories.length).toBeGreaterThanOrEqual(3);
        expect(result.memories.length).toBeLessThanOrEqual(8);

        for (const m of result.memories) {
            expect(m.symbol).toBe("INFY");
            expect(m.score).toBeGreaterThan(0);
            expect(m.narrative).toContain("INFY (NSE)");
            expect(m.narrative).toMatch(/outcome (target|stop|neither)/);
            const { rows } = await pool.query("SELECT o.hit FROM outcomes o JOIN memories mm ON mm.outcome_id = o.id WHERE mm.memory_key = $1", [m.memoryKey]);
            expect(rows[0].hit).toBe(m.hit); // verbatim: index row matches the journal fact
        }
        const hits = result.memories.map((m) => m.hit);
        expect(hits).toContain("stop"); // the loss is not hidden
    });

    it("replays: identical query + asOf -> byte-identical result; scores ordered", async () => {
        const args = { symbol: "INFY", regime: "UP_LOWVOL", asOf: tomorrowIso() };
        const a = await retrieval.retrieveMemories(args);
        const b = await retrieval.retrieveMemories(args);
        expect(b).toEqual(a);
        const scores = a.memories.map((m) => m.score);
        expect([...scores].sort((x, y) => y - x)).toEqual(scores);
    });

    it("asOf eligibility: nothing decided on or after asOf is ever retrieved", async () => {
        const past = await retrieval.retrieveMemories({ symbol: "INFY", asOf: "2020-01-01" });
        expect(past.memories).toHaveLength(0);
        const today = await retrieval.retrieveMemories({ symbol: "INFY" }); // asOf defaults to today; decisions dated today are excluded
        for (const m of today.memories) {
            expect(m.decisionDate < today.asOf).toBe(true);
        }
    });

    it("requires a symbol or regime and enforces the context budget", async () => {
        await expect(retrieval.retrieveMemories({})).rejects.toThrow(/symbol or a regime/);
        const capped = await retrieval.retrieveMemories({ symbol: "INFY", asOf: tomorrowIso(), limit: 2 });
        expect(capped.memories.length).toBeLessThanOrEqual(2);
    });

    it("retrieval is read-only by construction: the module contains no write statements", async () => {
        const { readFile } = await import("node:fs/promises");
        const src = await readFile(new URL("../services/memoryRetrieval.js", import.meta.url), "utf8");
        expect(src).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE/i);
    });

    it("stays within the latency budget", async () => {
        const started = performance.now();
        await retrieval.retrieveMemories({ symbol: "INFY", regime: "UP_LOWVOL", asOf: tomorrowIso() });
        expect(performance.now() - started).toBeLessThan(50);
    });
});
