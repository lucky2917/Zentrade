import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// The 2026-09-01 session, replayed.
//
// That session produced 41 decisions, 35 HOLD, one complete executable thesis
// and zero trades. This replays its real candidates — the same symbols, the
// same triggers, the same measured moves — and asserts what the system does
// with them now.
//
// Two claims are under test. That the candidates which could never have paid
// for their own round trip are turned away before a model call. And that a
// candidate which CAN pay, given a thesis with levels, reaches the risk gate
// and becomes a position.

describe.skipIf(!TEST_DB || !TEST_REDIS)("replaying the 2026-09-01 session", () => {
    let pool, redis, engine, reconcile, buildLivePorts, NewsStore, ConnectionTracker,
        AutonomousRuntime, makeCandidateAnalyser, BarAggregator, account;
    const USER = 8498;
    const SYMBOL = "ALOKINDS";

    // The real event-driven candidates, with the moves that triggered them.
    const WEAK = [
        { symbol: "COALINDIA", move: -0.0029, trigger: "PRICE_JUMP" },
        { symbol: "DELHIVERY", move: 0.0029, trigger: "PRICE_JUMP" },
        { symbol: "GSFC", move: 0.0026, trigger: "PRICE_JUMP" },
        { symbol: "NATIONALUM", move: 0.0038, trigger: "PRICE_JUMP" },
        { symbol: "BHEL", move: 0.0043, trigger: "PRICE_JUMP" },
        { symbol: "MOIL", move: null, trigger: "VOLATILITY_EXPANSION" },
        { symbol: "WIPRO", move: null, trigger: "VOLATILITY_EXPANSION" },
        { symbol: "DLF", move: null, trigger: "VOLATILITY_EXPANSION" },
        { symbol: "RPOWER", move: null, trigger: "VOLUME_SPIKE" },
        { symbol: "MRPL", move: null, trigger: "VOLUME_SPIKE" },
    ];
    // The real screen candidates, which cleared the hurdle comfortably.
    const STRONG = [
        { symbol: "ALOKINDS", move: 0.0729 }, { symbol: "ICIL", move: 0.0567 },
        { symbol: "OLAELEC", move: 0.0536 }, { symbol: "HDFCBANK", move: 0.0449 },
    ];

    const at = (h, m, s = 0) => Date.UTC(2026, 8, 1, h - 5, m - 30 + 60, s) - 3600_000;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        ({ default: redis } = await import("../config/redis.js"));
        engine = await import("../services/execution/engine.js");
        reconcile = await import("../services/execution/reconcile.js");
        ({ buildLivePorts } = await import("../services/autonomous/livePorts.js"));
        ({ NewsStore } = await import("../services/news/ingest.js"));
        ({ ConnectionTracker } = await import("../services/orchestrator/connectionState.js"));
        ({ AutonomousRuntime } = await import("../services/autonomous/runtime.js"));
        ({ makeCandidateAnalyser } = await import("../services/autonomous/reasoning.js"));
        ({ BarAggregator } = await import("../services/fyers/barAggregator.js"));
        account = await import("../services/account/paperAccount.js");
    });

    beforeEach(async () => {
        for (const t of ["model_calls", "candidate_cooldowns", "decision_records",
                         "position_events", "paper_account"]) {
            await pool.query(`DELETE FROM ${t} WHERE user_id=$1`, [USER]);
        }
        await pool.query(
            "DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM trade_thesis WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id,email,balance_paise) VALUES ($1,'replay@test',100000000)
             ON CONFLICT (id) DO UPDATE SET balance_paise=100000000`, [USER]);
        await account.ensureAccount({ userId: USER });
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const connected = () => {
        const c = new ConnectionTracker();
        c.onConnecting(); c.onConnected(); c.onTick(Date.now());
        return c;
    };

    const scriptTransport = (script) => {
        const calls = [];
        const fn = vi.fn(async (model, prompt, _t, _mt, sink, label) => {
            calls.push({ label, prompt });
            sink?.push({ agentName: label, modelId: model, status: "ok",
                         latencyMs: 100, promptTokens: 800, completionTokens: 200 });
            const answer = script[label];
            if (!answer) throw new Error(`no scripted answer for ${label}`);
            return typeof answer === "function" ? answer(prompt) : answer;
        });
        fn.calls = calls;
        return fn;
    };

    const makeRuntime = (transport) => {
        const ports = buildLivePorts({
            userId: USER, newsStore: new NewsStore(), connectionTracker: connected(),
            universe: [SYMBOL],
            analyseCandidate: makeCandidateAnalyser({ transport }),
        });
        return new AutonomousRuntime({
            engine, reconciler: reconcile, userId: USER,
            clock: () => new Date(at(12, 0)), ports });
    };

    // Tier 4 revalidates against a FRESH read of the world, so a candidate has
    // to be priced at the instant the decision is taken or it is refused as
    // stale — which is the gate doing its job, and is what this seeds past.
    const seedTick = async (symbol, price) => {
        await redis.set(`stock:${symbol}`, JSON.stringify({
            symbol, price, volume: 500000,
            timestamp: new Date(at(12, 0)).toISOString() }));
    };

    const context = (move, price = 1000) => ({
        price, asOf: new Date(at(12, 0)).toISOString(), stale: false,
        mtf: { complete: true, aligned: true, change5m: move, change1m: move },
        vwap: price * 0.99, vwapAvailable: true,
    });

    // ---- the calls that were being spent on nothing -------------------------

    it("spends no model call on a move that cannot pay its round trip", async () => {
        const transport = scriptTransport({});      // any call is a failure
        const runtime = makeRuntime(transport);

        const outcomes = [];
        for (const c of WEAK) {
            outcomes.push(await runtime.handleCandidate({
                symbol: c.symbol, context: context(c.move) }));
        }

        expect(transport.calls).toHaveLength(0);
        expect(outcomes.every((o) => typeof o.skipped === "string")).toBe(true);
        expect(runtime.metrics.candidatesBelowCostHurdle).toBe(WEAK.length);
        // And nothing was written to the decision record, because no decision
        // was made.
        expect(await account.recentDecisions({ userId: USER })).toHaveLength(0);
    });

    it("still reasons about every candidate that can pay", async () => {
        const transport = scriptTransport({
            senior_thesis_formation: {
                thesis: "aligned across timeframes and holding above VWAP",
                setup: "trend continuation", direction: "LONG",
                supportingEvidence: ["1m, 5m and 15m all up"],
                contradictingEvidence: ["breadth is mixed"],
                invalidationConditions: ["a close back under VWAP"],
                catalyst: "none identified", timeHorizon: "INTRADAY",
                uncertainty: ["depth not visible"], proposedAction: "HOLD",
                stopRupees: null, targetRupees: null, quantity: null,
            },
            senior_thesis_challenge: {
                verdict: "THESIS_WEAK", strongestObjection: "no catalyst",
                alternativeHypotheses: [], missingInformation: [],
                couldBeFalseSignal: true, whatWouldChangeTheDecision: ["volume"],
                confirmationBiasDetected: false,
            },
        });
        const runtime = makeRuntime(transport);
        for (const c of STRONG) {
            await runtime.handleCandidate({ symbol: c.symbol, context: context(c.move) });
        }
        // Two calls each: formation and challenge.
        expect(transport.calls).toHaveLength(STRONG.length * 2);
        expect(runtime.metrics.candidatesBelowCostHurdle).toBe(0);
    });

    // ---- the claim that matters: it reaches risk and executes ---------------

    it("carries a complete thesis through risk to a filled position", async () => {
        const transport = scriptTransport({
            senior_thesis_formation: {
                thesis: "morning range breakout, aligned across timeframes, holding above VWAP",
                setup: "range breakout", direction: "LONG",
                supportingEvidence: ["1m, 5m and 15m aligned up", "price above VWAP"],
                contradictingEvidence: ["already extended from the open"],
                invalidationConditions: ["a close back under 990"],
                catalyst: "range resolution", timeHorizon: "INTRADAY",
                uncertainty: ["order book depth not visible"],
                proposedAction: "BUY",
                // Entry 1000, stop 990, target 1030: risks 10 to make 30.
                stopRupees: 990, targetRupees: 1030, quantity: 300,
            },
            senior_thesis_challenge: {
                verdict: "THESIS_HOLDS", strongestObjection: "the move is extended",
                alternativeHypotheses: [
                    { explanation: "genuine breakout", supportedBy: "alignment",
                      plausibility: "HIGH" }],
                missingInformation: ["depth"], couldBeFalseSignal: false,
                whatWouldChangeTheDecision: ["a close back inside the range"],
                confirmationBiasDetected: false,
            },
        });
        const runtime = makeRuntime(transport);

        await seedTick(SYMBOL, 1000);
        const outcome = await runtime.handleCandidate({
            symbol: SYMBOL, context: context(0.0729, 1000) });
        await runtime.venue.tick();

        // It got past the model, the challenger, the cost arithmetic, the
        // risk/reward floor, Tier 4 revalidation and the risk gate.
        expect(outcome.executed).toBe(true);

        const { rows: orders } = await pool.query(
            "SELECT symbol, type, quantity, price_paise, state FROM orders WHERE user_id=$1", [USER]);
        expect(orders).toHaveLength(1);
        expect(orders[0]).toMatchObject({ symbol: SYMBOL, type: "BUY", state: "FILLED" });

        const { rows: held } = await pool.query(
            "SELECT quantity, avg_price_paise FROM portfolio WHERE user_id=$1", [USER]);
        expect(Number(held[0].quantity)).toBe(300);

        // The thesis that justified it is stored, with the levels.
        const { rows: thesis } = await pool.query(
            "SELECT stop_paise, target_paise, rationale FROM trade_thesis WHERE user_id=$1", [USER]);
        expect(Number(thesis[0].stop_paise)).toBe(99_000);
        expect(Number(thesis[0].target_paise)).toBe(103_000);

        // The decision record says the model proposed it and nothing blocked it.
        const [decision] = await account.recentDecisions({ userId: USER });
        expect(decision.action).toBe("BUY");
        expect(decision.executed).toBe(true);
        expect(decision.synthesis.proposedAction).toBe("BUY");
        expect(decision.synthesis.entryGates).toEqual([]);
        expect(Number(decision.synthesis.riskReward.ratio)).toBeCloseTo(3.0, 1);

        // And the calls it took to get there are on the record.
        const { rows: calls } = await pool.query(
            "SELECT agent_name, status FROM model_calls WHERE user_id=$1", [USER]);
        expect(calls).toHaveLength(2);
        expect(calls.every((c) => c.status === "ok")).toBe(true);

        // The position is armed against its stop.
        expect(runtime.reflex.isArmed(SYMBOL)).toBe(true);
    });

    it("still refuses a complete thesis whose risk/reward does not clear the floor",
       async () => {
        const transport = scriptTransport({
            senior_thesis_formation: {
                thesis: "breakout", setup: "range breakout", direction: "LONG",
                supportingEvidence: ["aligned"], contradictingEvidence: [],
                invalidationConditions: ["a close under 950"],
                catalyst: "none", timeHorizon: "INTRADAY", uncertainty: [],
                proposedAction: "BUY",
                // Risks 50 to make 42: below the 1.2 floor.
                stopRupees: 950, targetRupees: 1042, quantity: 100,
            },
            senior_thesis_challenge: {
                verdict: "THESIS_HOLDS", strongestObjection: "extended",
                alternativeHypotheses: [], missingInformation: [],
                couldBeFalseSignal: false, whatWouldChangeTheDecision: ["a close inside"],
                confirmationBiasDetected: false,
            },
        });
        const runtime = makeRuntime(transport);
        await seedTick(SYMBOL, 1000);
        const outcome = await runtime.handleCandidate({
            symbol: SYMBOL, context: context(0.0729, 1000) });

        expect(outcome.executed).toBeFalsy();
        expect((await pool.query(
            "SELECT COUNT(*)::int n FROM orders WHERE user_id=$1", [USER])).rows[0].n).toBe(0);

        // And the record now says exactly why: the model wanted it, the gate said no.
        const [decision] = await account.recentDecisions({ userId: USER });
        expect(decision.synthesis.proposedAction).toBe("BUY");
        expect(decision.synthesis.entryGates.join(" ")).toMatch(/below the 1\.2 floor/);
    });

    it("still refuses a BUY with no stop", async () => {
        const transport = scriptTransport({
            senior_thesis_formation: {
                thesis: "breakout", setup: "breakout", direction: "LONG",
                supportingEvidence: ["aligned"], contradictingEvidence: [],
                invalidationConditions: ["a close under VWAP"], catalyst: "none",
                timeHorizon: "INTRADAY", uncertainty: [], proposedAction: "BUY",
                stopRupees: null, targetRupees: 1030, quantity: 100,
            },
            senior_thesis_challenge: {
                verdict: "THESIS_HOLDS", strongestObjection: "extended",
                alternativeHypotheses: [], missingInformation: [],
                couldBeFalseSignal: false, whatWouldChangeTheDecision: ["a close inside"],
                confirmationBiasDetected: false,
            },
        });
        const runtime = makeRuntime(transport);
        await seedTick(SYMBOL, 1000);
        await runtime.handleCandidate({ symbol: SYMBOL, context: context(0.0729, 1000) });
        expect((await pool.query(
            "SELECT COUNT(*)::int n FROM orders WHERE user_id=$1", [USER])).rows[0].n).toBe(0);
    });
});
