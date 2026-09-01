import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// Lifecycles A-E through the REAL senior reasoning pipeline: TraderState is
// assembled from real bars, the formation and challenge prompts are really
// built, the deterministic synthesis really runs, the real risk gate decides,
// and the real Phase 1 engine fills. Only the model transport and the tick
// source are substituted.

describe.skipIf(!TEST_DB || !TEST_REDIS)("senior trader lifecycles", () => {
    let pool, redis, engine, reconcile, AutonomousRuntime, buildLivePorts;
    let BarAggregator, NewsStore, ConnectionTracker;
    let makeCandidateAnalyser, makeReassessmentModel;
    const USER = 8485;
    const CASH = 500_000_000;
    const SYMBOL = "RELIANCE";
    const at = (h, m, s = 0) => Date.UTC(2026, 8, 1, 0, h * 60 + m - 330, s);

    beforeEach(async () => {
        ({ pool } = await import("../config/db.js"));
        ({ default: redis } = await import("../config/redis.js"));
        engine = await import("../services/execution/engine.js");
        reconcile = await import("../services/execution/reconcile.js");
        ({ AutonomousRuntime } = await import("../services/autonomous/runtime.js"));
        ({ buildLivePorts } = await import("../services/autonomous/livePorts.js"));
        ({ BarAggregator } = await import("../services/fyers/barAggregator.js"));
        ({ NewsStore } = await import("../services/news/ingest.js"));
        ({ ConnectionTracker } = await import("../services/orchestrator/connectionState.js"));
        ({ makeCandidateAnalyser, makeReassessmentModel } =
            await import("../services/autonomous/reasoning.js"));

        await pool.query("DELETE FROM position_reassessments WHERE thesis_id IN (SELECT id FROM trade_thesis WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM position_events WHERE user_id=$1", [USER]);
        // Cooldowns are durable now, so a symbol priced by one test would
        // otherwise be skipped by the next.
        await pool.query("DELETE FROM candidate_cooldowns WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM trade_thesis WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'senior@test',$2)
             ON CONFLICT (id) DO UPDATE SET balance_paise=$2`, [USER, CASH]);
        await redis.del(`stock:${SYMBOL}`, `bars:1m:${SYMBOL}`, `bars:5m:${SYMBOL}`, `bars:15m:${SYMBOL}`);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const holding = async () => {
        const { rows } = await pool.query(
            "SELECT quantity FROM portfolio WHERE user_id=$1 AND symbol=$2", [USER, SYMBOL]);
        return rows.length ? Number(rows[0].quantity) : 0;
    };
    const orderCount = async () => (await pool.query(
        "SELECT COUNT(*)::int n FROM orders WHERE user_id=$1", [USER])).rows[0].n;

    const feedTicks = async (prices, startMinute = 0) => {
        const agg = new BarAggregator({ redis });
        let cumulative = 100000;
        for (let i = 0; i < prices.length; i += 1) {
            cumulative += 5000;
            await agg.ingest({ symbol: SYMBOL, price: prices[i], volume: cumulative,
                               timestamp: at(10, startMinute + i) });
        }
        await agg.flush();
        await redis.set(`stock:${SYMBOL}`, JSON.stringify({
            symbol: SYMBOL, price: prices[prices.length - 1], volume: cumulative,
            timestamp: new Date(at(11, 59, 30)).toISOString() }));
    };
    const calmThenMove = (last) => {
        const calm = Array.from({ length: 45 }, (_, i) => 1000 + (i % 2 ? -0.5 : 0.5));
        return [...calm, last];
    };

    const connected = () => {
        const c = new ConnectionTracker();
        c.onConnecting(); c.onConnected(); c.onTick(Date.now());
        return c;
    };

    // The scripted model transport. Records every prompt so the test can prove
    // what the reasoning path actually asked.
    const scriptTransport = (script) => {
        const calls = [];
        const fn = vi.fn(async (model, prompt, _t, _mt, sink, label) => {
            calls.push({ label, prompt, model });
            sink?.push({ agentName: label, modelId: model, status: "ok" });
            const answer = script[label];
            if (!answer) throw new Error(`no scripted answer for ${label}`);
            return typeof answer === "function" ? answer(prompt) : answer;
        });
        fn.calls = calls;
        return fn;
    };

    const makeRuntime = ({ transport, now = () => new Date(at(12, 0)) }) => {
        const ports = buildLivePorts({
            userId: USER, newsStore: new NewsStore(), connectionTracker: connected(),
            universe: [SYMBOL],
            analyseCandidate: makeCandidateAnalyser({ transport }),
            callModel: makeReassessmentModel({ transport }),
        });
        return new AutonomousRuntime({
            engine, reconciler: reconcile, userId: USER, clock: now, ports });
    };

    const seedPosition = async ({ entry = 100000, quantity = 200,
                                  stop = 97000, target = 110000 } = {}) => {
        const { order } = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side: "BUY", quantity,
            pricePaise: entry, clientOrderId: `seed-${Date.now()}`, correlationId: "seed" });
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        await engine.applyFill({ orderId: order.id, executionRef: "f1", quantity, pricePaise: entry });
        const { rows: [thesis] } = await pool.query(
            `INSERT INTO trade_thesis (user_id, symbol, correlation_id, side, entry_price_paise,
                quantity, rationale, setup_type, invalidation_conditions, supporting_evidence,
                horizon, stop_paise, target_paise)
             VALUES ($1,$2,'seed','BUY',$3,$4,'morning range breakout holding above VWAP','breakout',
                     '["close below 970 with volume"]'::jsonb,'[]'::jsonb,'INTRADAY',$5,$6)
             RETURNING *`, [USER, SYMBOL, entry, quantity, stop, target]);
        return thesis;
    };

    const soundChallenge = {
        verdict: "THESIS_HOLDS", strongestObjection: "the move is already extended",
        alternativeHypotheses: [
            { explanation: "genuine breakout", supportedBy: "volume and alignment", plausibility: "HIGH" },
            { explanation: "short covering", supportedBy: "no news retrieved", plausibility: "LOW" }],
        missingInformation: ["order book depth"], couldBeFalseSignal: false,
        whatWouldChangeTheDecision: ["a close back inside the range"],
        confirmationBiasDetected: false,
    };

    // ---- A ----------------------------------------------------------------
    it("LIFECYCLE A: thesis forms, survives challenge, clears costs, becomes a paper position", async () => {
        await feedTicks(calmThenMove(1030));
        const transport = scriptTransport({
            senior_thesis_formation: {
                thesis: "morning range breakout holding above VWAP on expanding volume",
                setup: "breakout", direction: "LONG",
                supportingEvidence: ["price above session VWAP", "all three timeframes up"],
                contradictingEvidence: [],
                invalidationConditions: ["close below 1010 on volume"],
                catalyst: "trend continuation", timeHorizon: "INTRADAY", uncertainty: [],
                proposedAction: "BUY", stopRupees: 1010, targetRupees: 1060, quantity: 200,
            },
            senior_thesis_challenge: soundChallenge,
        });

        const runtime = makeRuntime({ transport });
        await runtime.start();
        await runtime.candidateScan();
        await runtime.venue.tick();

        // Exactly two model calls: form then challenge.
        expect(transport.calls.map((c) => c.label))
            .toEqual(["senior_thesis_formation", "senior_thesis_challenge"]);
        // The formation prompt carried real assembled evidence, not raw ticks.
        expect(transport.calls[0].prompt).toContain("EVIDENCE (tier assigned by origin, not by you)");
        expect(transport.calls[0].prompt).toMatch(/one-minute bars observed this session/);
        expect(transport.calls[0].prompt).toContain("NO TRADE is a");
        // The challenger was told to break it, and was shown the thesis.
        expect(transport.calls[1].prompt).toContain("BREAK the following thesis");
        expect(transport.calls[1].prompt).toContain("morning range breakout");

        expect(await orderCount()).toBe(1);
        expect(await holding()).toBe(200);

        const { rows: [thesis] } = await pool.query(
            "SELECT * FROM trade_thesis WHERE user_id=$1 AND symbol=$2", [USER, SYMBOL]);
        expect(thesis.setup_type).toBe("breakout");
        expect(thesis.invalidation_conditions).toEqual(["close below 1010 on volume"]);
        expect(Number(thesis.stop_paise)).toBe(101000);
        expect(Number(thesis.target_paise)).toBe(106000);
        // Supporting evidence is tiered, and nothing the model said is a FACT.
        const tiers = new Set(thesis.supporting_evidence.map((e) => e.tier));
        expect(tiers.has("FACT")).toBe(true);
        expect(thesis.supporting_evidence
            .filter((e) => e.source === "thesis formation")
            .every((e) => e.tier === "INFERENCE")).toBe(true);

        await runtime.stop();
    }, 60000);

    // ---- B ----------------------------------------------------------------
    it("LIFECYCLE B: false breakout is broken by the challenger, ZERO orders", async () => {
        await feedTicks(calmThenMove(1030));
        const transport = scriptTransport({
            senior_thesis_formation: {
                thesis: "breakout to a new session high", setup: "breakout", direction: "LONG",
                supportingEvidence: ["new session high"], contradictingEvidence: [],
                invalidationConditions: ["failure to hold 1020"], timeHorizon: "INTRADAY",
                uncertainty: [], proposedAction: "BUY",
                stopRupees: 1010, targetRupees: 1060, quantity: 200,
            },
            senior_thesis_challenge: {
                verdict: "THESIS_BROKEN",
                strongestObjection: "the prior two attempts at this level failed",
                couldBeFalseSignal: true, falseSignalTell: "no volume expansion on the break",
                alternativeHypotheses: [
                    { explanation: "stop run above the range", supportedBy: "thin volume",
                      plausibility: "HIGH" }],
                whatWouldChangeTheDecision: ["a retest that holds on volume"],
            },
        });

        const runtime = makeRuntime({ transport });
        await runtime.start();
        await runtime.candidateScan();
        await runtime.venue.tick();

        expect(transport.calls).toHaveLength(2);      // it reasoned, then refused
        expect(await orderCount()).toBe(0);
        expect(await holding()).toBe(0);
        const { rows } = await pool.query("SELECT * FROM trade_thesis WHERE user_id=$1", [USER]);
        expect(rows).toHaveLength(0);
        await runtime.stop();
    }, 60000);

    // ---- C ----------------------------------------------------------------
    it("LIFECYCLE C: thesis weakens on a held position, reassessment is journalled", async () => {
        const thesis = await seedPosition();
        await feedTicks(calmThenMove(1005));

        const transport = scriptTransport({
            senior_reassess_formation: (prompt) => {
                // The reassessment must ask about the ORIGINAL thesis.
                expect(prompt).toContain("ORIGINAL THESIS (recorded at entry, immutable)");
                expect(prompt).toContain("morning range breakout holding above VWAP");
                expect(prompt).toContain("Do not ask whether you would buy it today");
                return {
                    thesis: "the breakout has stalled; momentum is fading",
                    setup: "breakout", direction: "LONG",
                    supportingEvidence: ["still above the entry price"],
                    contradictingEvidence: ["no new high in 20 minutes", "volume declining"],
                    invalidationConditions: ["close below 970 with volume"],
                    timeHorizon: "INTRADAY", uncertainty: ["whether this is a pause or a top"],
                    proposedAction: "REDUCE",
                };
            },
            senior_reassess_challenge: {
                verdict: "THESIS_WEAK",
                strongestObjection: "a stalling breakout usually retraces to the range",
                alternativeHypotheses: [
                    { explanation: "consolidation before continuation", supportedBy: "price holding",
                      plausibility: "MEDIUM" }],
                whatWouldChangeTheDecision: ["a new high on expanding volume"],
            },
        });

        const runtime = makeRuntime({ transport });
        await runtime.start();
        await runtime.orchestrator.monitorCycle();
        await runtime.orchestrator.reasoningCycle();
        await runtime.venue.tick();

        const { rows: [r] } = await pool.query(
            "SELECT * FROM position_reassessments WHERE thesis_id=$1 ORDER BY id DESC LIMIT 1",
            [thesis.id]);
        expect(r).toBeTruthy();
        expect(["REDUCE", "HOLD"]).toContain(r.action);
        expect(r.thesis_still_valid).toBe(true);
        expect(r.reasoning).toMatch(/momentum is fading|Deterministic checks|Confidence/);

        // The entry thesis was never rewritten.
        const { rows: [after] } = await pool.query(
            "SELECT rationale FROM trade_thesis WHERE id=$1", [thesis.id]);
        expect(after.rationale).toBe("morning range breakout holding above VWAP");
        await runtime.stop();
    }, 60000);

    // ---- D ----------------------------------------------------------------
    it("LIFECYCLE D: thesis invalidated, position exits, history is preserved", async () => {
        const thesis = await seedPosition();
        await feedTicks(calmThenMove(940));

        const transport = scriptTransport({
            senior_reassess_formation: {
                thesis: "the recorded invalidation condition has triggered",
                setup: "breakout", direction: "LONG", supportingEvidence: [],
                contradictingEvidence: ["closed below 970", "now far below the recorded stop"],
                invalidationConditions: ["close below 970 with volume"],
                timeHorizon: "INTRADAY", uncertainty: [], proposedAction: "EXIT",
            },
            senior_reassess_challenge: {
                verdict: "THESIS_BROKEN",
                strongestObjection: "the level that defined the thesis is gone",
                whatWouldChangeTheDecision: ["reclaiming 970 and holding it"],
            },
        });

        const runtime = makeRuntime({ transport });
        await runtime.start();
        await runtime.orchestrator.monitorCycle();
        expect(runtime.orchestrator.queue.size).toBeGreaterThan(0);
        await runtime.orchestrator.reasoningCycle();
        await runtime.venue.tick();

        expect(await holding()).toBe(0);
        const { rows: [r] } = await pool.query(
            "SELECT * FROM position_reassessments WHERE thesis_id=$1 ORDER BY id DESC LIMIT 1",
            [thesis.id]);
        expect(r.action).toBe("EXIT");
        expect(r.thesis_still_valid).toBe(false);
        const { rows: [after] } = await pool.query(
            "SELECT rationale FROM trade_thesis WHERE id=$1", [thesis.id]);
        expect(after.rationale).toBe("morning range breakout holding above VWAP");
        await runtime.stop();
    }, 60000);

    // ---- E ----------------------------------------------------------------
    it("LIFECYCLE E: a good-looking setup that cannot clear 73.55 bps is NOT traded", async () => {
        await feedTicks(calmThenMove(1030));
        const transport = scriptTransport({
            senior_thesis_formation: {
                thesis: "clean continuation setup with a tight, realistic target",
                setup: "breakout", direction: "LONG",
                supportingEvidence: ["above VWAP", "timeframes aligned", "orderly trend"],
                contradictingEvidence: [], invalidationConditions: ["loses 1025"],
                catalyst: "continuation", timeHorizon: "INTRADAY", uncertainty: [],
                proposedAction: "BUY",
                // 1030 -> 1033 is 29 bps gross, under the 73.55 bps round trip.
                stopRupees: 1025, targetRupees: 1033, quantity: 200,
            },
            senior_thesis_challenge: soundChallenge,
        });

        const runtime = makeRuntime({ transport });
        await runtime.start();
        await runtime.candidateScan();
        await runtime.venue.tick();

        // Lifecycle A is the control: identical evidence and challenge, the
        // only difference is a target that clears the round trip.
        expect(transport.calls).toHaveLength(2);      // it still reasoned
        expect(await orderCount()).toBe(0);           // and still refused
        expect(await holding()).toBe(0);
        await runtime.stop();
    }, 60000);

    // ---- economics --------------------------------------------------------
    it("a quiet position costs zero model calls", async () => {
        await seedPosition();
        await feedTicks(Array.from({ length: 46 }, (_, i) => 1000 + (i % 2 ? -0.2 : 0.2)));
        const transport = scriptTransport({});
        const runtime = makeRuntime({ transport });
        await runtime.start();
        await runtime.orchestrator.monitorCycle();
        await runtime.orchestrator.reasoningCycle();
        expect(transport).not.toHaveBeenCalled();
        await runtime.stop();
    }, 60000);
});
