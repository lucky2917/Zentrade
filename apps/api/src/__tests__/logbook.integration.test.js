import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// The logbook is the durable record of a session, read back whole.
//
// Two things have to hold. Everything the system wrote for a day comes back,
// including the reasoning behind a decision that was never executed, because a
// declined candidate is the part of the record that is hardest to reconstruct
// later. And a day means the IST calendar day it was, not whatever the DATE
// column deserialises to in the reader's timezone.

describe.skipIf(!TEST_DB || !TEST_REDIS)("session logbook", () => {
    let pool, redis, account, calls, logbook;
    const USER = 8493;

    const DAY = "2026-08-24";
    const PRIOR = "2026-08-21";
    // 10:15 IST, as a UTC instant.
    const at = (d) => new Date(`${d}T04:45:00.000Z`);

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        ({ default: redis } = await import("../config/redis.js"));
        account = await import("../services/account/paperAccount.js");
        calls = await import("../services/account/modelCalls.js");
        logbook = await import("../services/cockpit/logbook.js");
    });

    beforeEach(async () => {
        for (const table of ["agent_events", "session_summaries", "decision_records",
                             "model_calls", "paper_account"]) {
            await pool.query(`DELETE FROM ${table} WHERE user_id=$1`, [USER]);
        }
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'logbook@test',100000000)
             ON CONFLICT (id) DO UPDATE SET balance_paise=100000000`, [USER]);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const declined = {
        decisionId: "lb-hold-1", correlationId: "lb-hold-1", symbol: "IFCI",
        route: "CANDIDATE", action: "HOLD", confidence: "MEDIUM",
        triggerType: "screen", triggerReason: "move 10.13%; volume 17.9x",
        evidence: [
            { tier: "FACT", source: "volume", value: 17.9,
              statement: "last minute traded 17.9x its 60-bar median volume" },
            { tier: "OBSERVATION", source: "session vwap", value: -0.0024,
              statement: "price is 0.24% below session VWAP" },
        ],
        thesis: "Extended move on real participation, but entry is below VWAP.",
        supporting: ["volume confirms the move"],
        contradicting: ["price is below VWAP"],
        counterThesis: "The move is already spent and the pullback continues.",
        alternatives: ["wait for a reclaim of VWAP"],
        whatWouldChange: ["a 1m close above VWAP on sustained volume"],
        challengeVerdict: "THESIS_WEAK",
        synthesis: { proposedAction: "HOLD", riskReward: { ratio: 1.1 },
                     entryGates: ["reclaim VWAP"], setupType: "momentum" },
        riskDecision: null, executed: false, pricePaise: 6875,
        decidedAt: at(DAY),
    };

    it("returns the whole day, reasoning included, and nothing from another day", async () => {
        await account.recordDecision({ userId: USER, record: declined });
        await account.recordDecision({ userId: USER, record: {
            ...declined, decisionId: "lb-old-1", correlationId: "lb-old-1",
            symbol: "BEML", decidedAt: at(PRIOR) } });
        await calls.recordModelCalls({
            userId: USER, symbol: "IFCI", decisionId: "lb-hold-1", at: at(DAY),
            runs: [{ agentName: "senior_thesis_formation", modelId: "openai/gpt-oss-120b",
                     status: "ok", latencyMs: 1200, promptTokens: 1522, completionTokens: 616 },
                   { agentName: "senior_thesis_challenge", modelId: "openai/gpt-oss-120b",
                     status: "failed", latencyMs: 0, output: { error: "Groq API error 429" } }] });
        await account.recordAgentEvent({
            userId: USER, kind: "AGENT_START", detail: { pid: 1 }, at: at(DAY) });

        const log = await logbook.readLogbook({ userId: USER, sessionDate: DAY });

        expect(log.sessionDate).toBe(DAY);
        expect(log.decisions).toHaveLength(1);
        expect(log.modelCalls).toHaveLength(2);
        expect(log.agentEvents).toHaveLength(1);

        // The reasoning survives the round trip. This is the record that cannot
        // be rebuilt from orders and fills, because no order was ever placed.
        const [d] = log.decisions;
        expect(d).toMatchObject({
            symbol: "IFCI", action: "HOLD", executed: false,
            challengeVerdict: "THESIS_WEAK",
            counterThesis: "The move is already spent and the pullback continues.",
        });
        expect(d.evidence.map((e) => e.tier)).toEqual(["FACT", "OBSERVATION"]);
        expect(d.contradicting).toEqual(["price is below VWAP"]);
        expect(d.whatWouldChange).toHaveLength(1);
        expect(d.synthesis.riskReward.ratio).toBe(1.1);
        expect(d.trigger).toMatchObject({ type: "screen" });

        // A failed call cost budget and produced nothing. It stays in the record.
        expect(log.modelCalls.map((c) => c.status).sort()).toEqual(["failed", "ok"]);
        expect(log.modelCalls.find((c) => c.status === "failed").error).toContain("429");
    });

    it("reports available days as IST calendar days", async () => {
        await account.ensureAccount({ userId: USER, at: at(PRIOR) });
        for (const day of [PRIOR, DAY]) {
            const state = await account.accountState({ userId: USER, at: at(day) });
            await account.writeSessionSummary({ userId: USER, state, at: at(day) });
        }

        const log = await logbook.readLogbook({ userId: USER, sessionDate: DAY });

        // Not the previous day, which is what a DATE deserialised to a local
        // midnight and sliced as an ISO string would give.
        expect(log.availableDates).toEqual([DAY, PRIOR]);
        expect(log.summary.session_date).toBe(DAY);
    });

    it("defaults to today and reads an empty session without failing", async () => {
        const log = await logbook.readLogbook({ userId: USER });
        expect(log.sessionDate).toBe(account.sessionDateOf(new Date()));
        expect(log.decisions).toEqual([]);
        expect(log.summary).toBeNull();
    });
});
