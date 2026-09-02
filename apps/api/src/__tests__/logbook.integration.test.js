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
                             "model_calls", "paper_account", "position_events"]) {
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

    it("counts the whole day even when the read is limited", async () => {
        for (let i = 0; i < 5; i += 1) {
            await account.recordDecision({ userId: USER, record: {
                ...declined, decisionId: `lb-n-${i}`, correlationId: `lb-n-${i}`,
                decidedAt: at(DAY) } });
        }

        const full = await logbook.readLogbook({ userId: USER, sessionDate: DAY });
        expect(full.counts.decisions).toBe(5);
        expect(full.returned.decisions).toBe(5);
        expect(full.truncated).toEqual([]);

        // A limited read still reports the true size of the day, so the page can
        // say it is showing part of it rather than presenting it as complete.
        const short = await logbook.readLogbook({ userId: USER, sessionDate: DAY, limit: 2 });
        expect(short.decisions).toHaveLength(2);
        expect(short.counts.decisions).toBe(5);
        expect(short.returned.decisions).toBe(2);
        expect(short.truncated).toContain("decisions");
    });

    it("keeps a past session to its own day", async () => {
        // Events are filtered on a timestamp range, not an exact session date.
        // Without an upper bound, reading an older day pulled in every later one.
        await account.recordAgentEvent({
            userId: USER, kind: "AGENT_START", detail: {}, at: at(PRIOR) });
        await account.recordAgentEvent({
            userId: USER, kind: "AGENT_STOP", detail: {}, at: at(DAY) });
        await pool.query(
            `INSERT INTO position_events
               (user_id, event_key, correlation_id, source, event_type, severity,
                symbol, reason, observed, state, observed_at)
             VALUES ($1,$2,'corr-old','test','VOLUME_SPIKE','CRITICAL','TCS','older day','{}'::jsonb,'PENDING',$3),
                    ($1,$4,'corr-new','test','VOLUME_SPIKE','CRITICAL','TCS','later day','{}'::jsonb,'PENDING',$5)`,
            [USER, `k-${PRIOR}`, at(PRIOR), `k-${DAY}`, at(DAY)]);

        const older = await logbook.readLogbook({ userId: USER, sessionDate: PRIOR });
        expect(older.marketEvents.map((e) => e.reason)).toEqual(["older day"]);
        expect(older.counts.marketEvents).toBe(1);
        expect(older.agentEvents.map((e) => e.kind)).toEqual(["AGENT_START"]);
    });

    // The record must not appear to vanish overnight. Defaulting to today empties
    // the page every midnight and on every non-trading day, and the day being
    // shown must always be one the date selector can offer.
    it("opens on the most recent day that holds something", async () => {
        await account.recordDecision({ userId: USER, record: declined });

        const log = await logbook.readLogbook({ userId: USER });
        expect(log.today).toBe(account.sessionDateOf(new Date()));
        expect(log.sessionDate).toBe(DAY);
        expect(log.decisions).toHaveLength(1);
        expect(log.availableDates).toContain(DAY);
        expect(log.availableDates).toContain(log.sessionDate);
    });

    it("offers days that never reached a session summary", async () => {
        await account.recordDecision({ userId: USER, record: declined });
        const log = await logbook.readLogbook({ userId: USER, sessionDate: DAY });
        // No summary was written for this day, but it still holds decisions.
        expect(log.summary).toBeNull();
        expect(log.availableDates).toContain(DAY);
    });

    it("still honours an explicitly requested empty day", async () => {
        await account.recordDecision({ userId: USER, record: declined });
        const today = account.sessionDateOf(new Date());
        const log = await logbook.readLogbook({ userId: USER, sessionDate: today });
        expect(log.sessionDate).toBe(today);
        expect(log.decisions).toEqual([]);
    });

    it("reads an empty account without failing", async () => {
        const log = await logbook.readLogbook({ userId: USER });
        expect(log.sessionDate).toBe(account.sessionDateOf(new Date()));
        expect(log.decisions).toEqual([]);
        expect(log.summary).toBeNull();
    });
});
