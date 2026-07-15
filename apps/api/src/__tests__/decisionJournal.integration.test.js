import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Decision Journal integration (M7): real Postgres + real Redis.
 * Covers: full lineage write, transactional event, FK integrity,
 * append-only enforcement (UPDATE/DELETE/TRUNCATE), hash stability,
 * flag-off dark behavior, unregistered-instrument rejection.
 *
 * Journal rows are append-only by design — tests assert DELTAS and use
 * their own correlation-scoped rows; they never clean journal tables.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const HASH_A = "a".repeat(64);

const fixtureRun = (agentName, overrides = {}) => ({
    agentName,
    agentVersion: "v4.0.0",
    modelId: "llama-3.3-70b-versatile",
    inputHash: HASH_A,
    output: { signal: "BULLISH", confidence: "MEDIUM", keyPoints: ["p1", "p2"] },
    status: "ok",
    latencyMs: 640,
    promptTokens: 900,
    completionTokens: 140,
    costUsd: 0.000642,
    ...overrides,
});

const fixtureEvidence = () => [
    { ref: "price:live", kind: "price", sourceRef: "redis:stock-cache", content: { price: 1518.4 }, weight: null },
    { ref: "ind:rsi14", kind: "indicator", sourceRef: "fyers:candles:D:365", content: { rsi14: 61.2 }, weight: null },
    { ref: "news:1", kind: "news", sourceRef: "finnhub:company-news", content: { headline: "h", source: "s" }, weight: null },
];

const fixtureInput = (overrides = {}) => ({
    symbol: "RELIANCE",
    trigger: "test",
    contextSnapshot: {
        price: 1518.4,
        changePercent: 1.02,
        priceTimestamp: 1783929474262,
        marketOpen: false,
        inputsHash: HASH_A,
    },
    evidence: fixtureEvidence(),
    runs: [fixtureRun("technical"), fixtureRun("sentiment"), fixtureRun("risk"), fixtureRun("synthesizer")],
    decision: {
        action: "BUY",
        mode: "INTRADAY",
        confidence: "MEDIUM",
        entryMinor: 151800,
        targetMinor: 153650,
        stopMinor: 151050,
        rationale: { traderNote: "note", reasoning: ["r1", "r2"], consensus: "majority", macroScore: 0 },
        synthesizerVersion: "v4.0.0",
    },
    ...overrides,
});

describe.skipIf(!TEST_DB || !TEST_REDIS)("decision journal (integration)", () => {
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

    it("writes the full lineage in one transaction: request, 4 runs, decision, event", async () => {
        const { requestId, decisionId, correlationId } = await journal.journalAnalysis(fixtureInput());

        const req = (await pool.query("SELECT * FROM decision_requests WHERE id = $1", [requestId])).rows[0];
        expect(req.requested_by).toBe("test");
        expect(req.context_snapshot.inputsHash).toBe(HASH_A);
        expect(req.regime).toEqual({ taxonomy: "none", label: "unlabeled" });

        const runs = (await pool.query("SELECT * FROM agent_runs WHERE request_id = $1 ORDER BY agent_name", [requestId])).rows;
        expect(runs.map((r) => r.agent_name)).toEqual(["risk", "sentiment", "synthesizer", "technical"]);
        expect(runs.every((r) => r.input_hash === HASH_A && r.status === "ok")).toBe(true);
        expect(Number(runs[0].cost_usd)).toBeCloseTo(0.000642, 6);

        const decision = (await pool.query("SELECT * FROM decisions WHERE id = $1", [decisionId])).rows[0];
        expect(decision.request_id).toBe(requestId);
        expect(decision.action).toBe("BUY");
        expect(Number(decision.entry_minor)).toBe(151800);
        expect(decision.correlation_id).toBe(correlationId);

        // the announcing event committed with the rows, carrying the same lineage
        const { rows: events } = await pool.query(
            "SELECT payload FROM outbox WHERE event_type = 'intel.decision.published' AND payload->'payload'->>'decisionId' = $1",
            [decisionId]
        );
        expect(events).toHaveLength(1);
        expect(events[0].payload.correlationId).toBe(correlationId);
        expect(events[0].payload.payload).toMatchObject({
            requestId,
            symbol: "RELIANCE",
            action: "BUY",
            entryMinor: 151800,
            agentRunCount: 4,
            currency: "INR",
        });
    });

    it("instrument FK: decision rows point at the registry, not at strings", async () => {
        const { decisionId } = await journal.journalAnalysis(fixtureInput());
        const { rows } = await pool.query(
            `SELECT i.symbol, i.venue FROM decisions d JOIN instruments i ON i.id = d.instrument_id WHERE d.id = $1`,
            [decisionId]
        );
        expect(rows[0]).toEqual({ symbol: "RELIANCE", venue: "NSE" });
    });

    it("append-only: UPDATE, DELETE and TRUNCATE are all rejected by the database", async () => {
        const { requestId, decisionId } = await journal.journalAnalysis(fixtureInput());

        await expect(pool.query("UPDATE decisions SET action = 'SELL' WHERE id = $1", [decisionId])).rejects.toThrow(/append-only/);
        await expect(pool.query("DELETE FROM agent_runs WHERE request_id = $1", [requestId])).rejects.toThrow(/append-only/);
        await expect(pool.query("UPDATE decision_requests SET requested_by = 'tampered' WHERE id = $1", [requestId])).rejects.toThrow(/append-only/);
        await expect(pool.query("TRUNCATE decisions CASCADE")).rejects.toThrow(/append-only/);
        await expect(pool.query("TRUNCATE agent_runs")).rejects.toThrow(/append-only/);

        // and the rows are still intact
        const { rows } = await pool.query("SELECT action FROM decisions WHERE id = $1", [decisionId]);
        expect(rows[0].action).toBe("BUY");
    });

    it("identical logical inputs produce identical input hashes across separate journal writes", async () => {
        const a = await journal.journalAnalysis(fixtureInput());
        const b = await journal.journalAnalysis(fixtureInput());
        const hashes = await pool.query(
            "SELECT DISTINCT input_hash FROM agent_runs WHERE request_id IN ($1, $2)",
            [a.requestId, b.requestId]
        );
        expect(hashes.rows).toHaveLength(1);
        expect(a.requestId).not.toBe(b.requestId); // distinct historical rows
    });

    it("a failed deliberation journals its runs with no decision row and no event", async () => {
        const before = (await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE event_type = 'intel.decision.published'")).rows[0].n;
        const { requestId, decisionId } = await journal.journalAnalysis(
            fixtureInput({ decision: null, runs: [fixtureRun("technical", { status: "failed", output: { error: "Groq API error 500" } })] })
        );
        expect(decisionId).toBeNull();
        const runs = (await pool.query("SELECT status FROM agent_runs WHERE request_id = $1", [requestId])).rows;
        expect(runs).toEqual([{ status: "failed" }]);
        const after = (await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE event_type = 'intel.decision.published'")).rows[0].n;
        expect(after).toBe(before);
    });

    it("flag off: journalSafely is a no-op writing zero rows", async () => {
        delete process.env.JOURNAL_ENABLED;
        const before = (await pool.query("SELECT COUNT(*)::int AS n FROM decision_requests")).rows[0].n;
        const result = await journal.journalSafely(fixtureInput());
        expect(result).toBeNull();
        const after = (await pool.query("SELECT COUNT(*)::int AS n FROM decision_requests")).rows[0].n;
        expect(after).toBe(before);
    });

    it("flag on: journalSafely writes and reports; garbage input fails safe (null, no throw)", async () => {
        process.env.JOURNAL_ENABLED = "1";
        const ok = await journal.journalSafely(fixtureInput());
        expect(ok.decisionId).toMatch(/^[0-9a-f-]{36}$/);

        const bad = await journal.journalSafely(fixtureInput({ decision: { action: "MOON" } }));
        expect(bad).toBeNull(); // validation failed, analysis path unharmed
        delete process.env.JOURNAL_ENABLED;
    });

    it("unregistered instruments are rejected — no journal row without registry identity", async () => {
        await expect(journal.journalAnalysis(fixtureInput({ symbol: "NOTREAL" }))).rejects.toThrow(/unregistered/);
    });
});
