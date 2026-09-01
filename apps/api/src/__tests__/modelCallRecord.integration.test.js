import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// Where the model calls went.
//
// Every call was already recorded into a sink and returned as
// decision.agentRuns, and nothing wrote it down. During the 2026-09-01 session
// the call rate had to be inferred by multiplying decisions by two, and the six
// calls that died on a rate limit — the ones that mattered — left no trace.

describe.skipIf(!TEST_DB || !TEST_REDIS)("the trader records what it asked the model", () => {
    let pool, redis, calls, ports;
    const USER = 8497;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        ({ default: redis } = await import("../config/redis.js"));
        calls = await import("../services/account/modelCalls.js");
        const { buildLivePorts } = await import("../services/autonomous/livePorts.js");
        ports = buildLivePorts({ userId: USER, newsStore: null, connectionTracker: null });
    });

    beforeEach(async () => {
        await pool.query("DELETE FROM model_calls WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM candidate_cooldowns WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM decision_records WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id,email,balance_paise) VALUES ($1,'calls@test',100000000)
             ON CONFLICT (id) DO NOTHING`, [USER]);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const run = (over = {}) => ({
        agentName: "senior_thesis_formation", agentVersion: "v1",
        modelId: "openai/gpt-oss-120b", status: "ok", latencyMs: 1200,
        promptTokens: 900, completionTokens: 240, output: {}, ...over,
    });

    it("writes one row per call", async () => {
        const n = await calls.recordModelCalls({
            userId: USER, symbol: "TCS", decisionId: "d-1", correlationId: "c-1",
            runs: [run(), run({ agentName: "senior_thesis_challenge", latencyMs: 900 })] });
        expect(n).toBe(2);

        const summary = await calls.modelCallSummary({ userId: USER });
        expect(summary.map((s) => s.agent_name).sort())
            .toEqual(["senior_thesis_challenge", "senior_thesis_formation"]);
        expect(summary.every((s) => s.status === "ok")).toBe(true);
    });

    // The whole point: a call that cost budget and produced nothing.
    it("records a call that failed on a rate limit", async () => {
        await calls.recordModelCalls({
            userId: USER, symbol: "BHEL", decisionId: "d-2",
            runs: [run({ status: "failed", output: { error: "Groq API error 429" } })] });

        const { rows } = await pool.query(
            "SELECT status, error, symbol FROM model_calls WHERE user_id=$1", [USER]);
        expect(rows[0]).toMatchObject({ status: "failed", symbol: "BHEL" });
        expect(rows[0].error).toContain("429");
    });

    it("reports the call rate a limit is actually judged against", async () => {
        await calls.recordModelCalls({ userId: USER, decisionId: "d-3",
            runs: [run(), run(), run({ status: "failed", output: { error: "429" } })] });
        const rate = await calls.modelCallRate({ userId: USER });
        expect(rate).toHaveLength(1);
        expect(rate[0].calls).toBe(3);
        expect(rate[0].failed).toBe(1);
    });

    it("writes nothing when there were no calls", async () => {
        expect(await calls.recordModelCalls({ userId: USER, runs: [] })).toBe(0);
        expect(await calls.recordModelCalls({ userId: USER, runs: undefined })).toBe(0);
    });

    // A record that cannot be written must never fail the decision it describes.
    it("swallows a write failure rather than losing the decision", async () => {
        const broken = { query: async () => { throw new Error("table is gone"); } };
        const warnings = [];
        const written = await calls.recordModelCalls({
            userId: USER, runs: [run()], db: broken,
            logger: { warn: (...a) => warnings.push(a) } });
        expect(written).toBe(0);
        expect(warnings).toHaveLength(1);
    });

    describe("the candidate cooldown survives a restart", () => {
        it("reads back what was recently reasoned about", async () => {
            const at = Date.now() - 60_000;
            await ports.markCandidateReasoned("OLAELEC", at);
            const loaded = await ports.loadCandidateCooldowns();
            expect(loaded).toHaveLength(1);
            expect(loaded[0][0]).toBe("OLAELEC");
            expect(Math.abs(loaded[0][1] - at)).toBeLessThan(1000);
        });

        it("keeps one row per symbol, refreshed", async () => {
            await ports.markCandidateReasoned("TCS", Date.now() - 600_000);
            await ports.markCandidateReasoned("TCS", Date.now());
            const loaded = await ports.loadCandidateCooldowns();
            expect(loaded).toHaveLength(1);
            expect(Date.now() - loaded[0][1]).toBeLessThan(5_000);
        });

        it("forgets a symbol priced long enough ago to be worth re-pricing", async () => {
            await pool.query(
                `INSERT INTO candidate_cooldowns (user_id,symbol,reasoned_at)
                 VALUES ($1,'STALE', NOW() - INTERVAL '2 hours')`, [USER]);
            expect(await ports.loadCandidateCooldowns()).toHaveLength(0);
        });
    });
});
