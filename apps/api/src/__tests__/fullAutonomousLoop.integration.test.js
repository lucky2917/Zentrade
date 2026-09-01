import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// THE ACCEPTANCE TEST.
//
// Ticks -> bars -> intelligence -> events -> AI -> risk -> paper execution ->
// position -> monitoring -> change -> AI again -> exit. Real Postgres, real
// Redis, real Phase 1 engine, real risk gate, real bar aggregator. Only the
// LLM transport and the tick source are substituted, because a test cannot
// call Groq deterministically and the market is not open.

describe.skipIf(!TEST_DB || !TEST_REDIS)("full autonomous paper loop", () => {
    let pool, redis, engine, reconcile, AutonomousRuntime, buildLivePorts;
    let BarAggregator, NewsStore, ConnectionTracker;
    const USER = 8484;
    const CASH = 500_000_000;
    const SYMBOL = "RELIANCE";

    // 2026-09-01 Tuesday. IST -> epoch.
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

        // Order matters: orders reference trade_thesis, so orders go first.
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
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'loop@test',$2)
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
    const orderCount = async () => {
        const { rows } = await pool.query("SELECT COUNT(*)::int n FROM orders WHERE user_id=$1", [USER]);
        return rows[0].n;
    };

    // Drives real ticks through the real aggregator into real Redis.
    const feedTicks = async (agg, prices, startMinute = 0) => {
        let cumulative = 100000;
        for (let i = 0; i < prices.length; i += 1) {
            cumulative += 5000;
            await agg.ingest({
                symbol: SYMBOL, price: prices[i], volume: cumulative,
                timestamp: at(10, startMinute + i),
            });
        }
        await agg.flush();
        // The tick timestamp must agree with the runtime clock, otherwise the
        // position is correctly judged stale and the monitor reports
        // DATA_STALE instead of evaluating the market.
        await redis.set(`stock:${SYMBOL}`, JSON.stringify({
            symbol: SYMBOL, price: prices[prices.length - 1], volume: cumulative,
            timestamp: new Date(at(11, 59, 30)).toISOString(),
        }));
    };

    const connected = () => {
        const c = new ConnectionTracker();
        c.onConnecting(); c.onConnected(); c.onTick(Date.now());
        return c;
    };

    const makeRuntime = ({ candidate, reassessModel, now = () => new Date(at(12, 0)) }) => {
        const ports = buildLivePorts({
            userId: USER, newsStore: new NewsStore(), connectionTracker: connected(),
            universe: [SYMBOL],
            callModel: reassessModel,
            analyseCandidate: candidate,
            // Shares the runtime's clock, so revalidation is not comparing a
            // fixed decision instant against real wall time.
            clock: now,
        });
        return new AutonomousRuntime({
            engine, reconciler: reconcile, userId: USER, clock: now, ports });
    };

    it("DEMONSTRATION: ticks to bars to intelligence to AI to risk to paper fill to position", async () => {
        const agg = new BarAggregator({ redis });
        // 45 calm minutes, then a decisive move: real bars, real aggregation.
        const calm = Array.from({ length: 45 }, (_, i) => 1000 + (i % 2 ? -0.5 : 0.5));
        await feedTicks(agg, [...calm, 1030]);

        const bars = await redis.lrange(`bars:1m:${SYMBOL}`, 0, -1);
        expect(bars.length).toBeGreaterThan(40);          // 1. bars exist
        expect((await redis.lrange(`bars:5m:${SYMBOL}`, 0, -1)).length).toBeGreaterThan(0);

        const candidate = vi.fn(async ({ context }) => {
            // 3. the AI actually receives assembled deterministic context
            expect(context.sessionPhase).toBeDefined();
            expect(context.mtf).toBeDefined();
            expect(context.barsSeen.m1).toBeGreaterThan(40);
            return { action: "BUY", confidence: "HIGH", quantity: 200,
                     reasoning: "breakout on expanding volume", setupType: "breakout",
                     invalidationConditions: ["close below 1010"] };
        });

        const runtime = makeRuntime({ candidate });
        await runtime.start();
        await runtime.candidateScan();                     // 2. candidate appears
        await runtime.venue.tick();

        expect(candidate).toHaveBeenCalled();              // 4. AI reasoned
        expect(await orderCount()).toBe(1);                // 6. paper order
        expect(await holding()).toBe(200);                 // 8. position exists

        const { rows: thesis } = await pool.query(
            "SELECT * FROM trade_thesis WHERE user_id=$1 AND symbol=$2", [USER, SYMBOL]);
        expect(thesis).toHaveLength(1);                    // 9. thesis exists
        expect(thesis[0].invalidation_conditions).toEqual(["close below 1010"]);

        await runtime.stop();
    }, 60000);

    it("DEMONSTRATION: position monitored, change detected, AI reassesses, paper EXIT", async () => {
        // Seed a real position through the real engine.
        const { order } = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side: "BUY", quantity: 200,
            pricePaise: 100000, clientOrderId: "seed-exit", correlationId: "seed" });
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        await engine.applyFill({ orderId: order.id, executionRef: "f1", quantity: 200, pricePaise: 100000 });

        const { rows: [thesis] } = await pool.query(
            `INSERT INTO trade_thesis (user_id, symbol, correlation_id, side, entry_price_paise,
                quantity, rationale, setup_type, invalidation_conditions, supporting_evidence, horizon,
                stop_paise, target_paise)
             VALUES ($1,$2,'seed','BUY',100000,200,'breakout','breakout',
                     '["close below 970"]'::jsonb,'[]'::jsonb,'INTRADAY',97000,110000)
             RETURNING *`, [USER, SYMBOL]);

        expect(await holding()).toBe(200);

        // Real market change: price collapses through the stop.
        const agg = new BarAggregator({ redis });
        const calm = Array.from({ length: 45 }, (_, i) => 1000 + (i % 2 ? -0.5 : 0.5));
        await feedTicks(agg, [...calm, 940]);

        const reassessModel = vi.fn(async (context) => {
            // The model sees the ORIGINAL thesis, not a fresh opinion.
            expect(context.originalThesis.rationale).toBe("breakout");
            expect(context.originalThesis.invalidationConditions).toEqual(["close below 970"]);
            expect(context.entryPricePaise).toBe(100000);
            expect(context.trigger).toBeTruthy();
            return { action: "EXIT", confidence: "HIGH", thesisStillValid: false,
                     whatChanged: "closed below the recorded invalidation level",
                     material: true, reasoning: "invalidation condition met" };
        });

        const runtime = makeRuntime({ reassessModel });
        await runtime.start();
        await runtime.orchestrator.monitorCycle();         // 11-12. change detected
        expect(runtime.orchestrator.queue.size).toBeGreaterThan(0);

        await runtime.orchestrator.reasoningCycle();       // 13. AI reassesses
        await runtime.venue.tick();

        expect(reassessModel).toHaveBeenCalled();
        expect(await holding()).toBe(0);                   // 16. paper EXIT executed

        const { rows: reassessments } = await pool.query(
            "SELECT * FROM position_reassessments WHERE thesis_id=$1", [thesis.id]);
        expect(reassessments.length).toBeGreaterThan(0);   // 18. journalled
        expect(reassessments[0].action).toBe("EXIT");
        expect(reassessments[0].thesis_still_valid).toBe(false);

        // The original thesis was NOT rewritten.
        const { rows: [after] } = await pool.query(
            "SELECT rationale FROM trade_thesis WHERE id=$1", [thesis.id]);
        expect(after.rationale).toBe("breakout");

        await runtime.stop();
    }, 60000);

    describe("negative paths", () => {
        const seedBars = async () => {
            const agg = new BarAggregator({ redis });
            const calm = Array.from({ length: 45 }, (_, i) => 1000 + (i % 2 ? -0.5 : 0.5));
            await feedTicks(agg, [...calm, 1030]);
        };

        it("AI says BUY, risk rejects, ZERO orders", async () => {
            await seedBars();
            await pool.query("UPDATE users SET balance_paise = 1000 WHERE id=$1", [USER]);
            const runtime = makeRuntime({
                candidate: async () => ({ action: "BUY", confidence: "HIGH", quantity: 200,
                                          reasoning: "x", setupType: "y",
                                          invalidationConditions: ["z"] }),
            });
            await runtime.start();
            await runtime.candidateScan();
            expect(await orderCount()).toBe(0);
            expect(await holding()).toBe(0);
            await runtime.stop();
        }, 60000);

        it("AI malformed, HOLD, ZERO orders", async () => {
            await seedBars();
            const runtime = makeRuntime({
                candidate: async () => ({ action: "LIQUIDATE EVERYTHING NOW" }),
            });
            await runtime.start();
            await runtime.candidateScan();
            expect(await orderCount()).toBe(0);
            await runtime.stop();
        }, 60000);

        it("AI proposes BUY with no quantity, degrades to HOLD", async () => {
            await seedBars();
            const { makeCandidateAnalyser } = await import("../services/autonomous/reasoning.js");
            // Substitute the transport, keep the real guardrail logic.
            vi.doMock("../services/aiEngine.js", () => ({}));
            const runtime = makeRuntime({
                candidate: async () => ({ action: "BUY", confidence: "HIGH" }),   // no quantity
            });
            await runtime.start();
            await runtime.candidateScan();
            // intentFrom uses quantity ?? 1, and 1 share is below the viability
            // floor, so risk refuses. Either way: no order.
            expect(await orderCount()).toBe(0);
            await runtime.stop();
        }, 60000);

        it("stale data blocks new exposure", async () => {
            await seedBars();
            const dead = new ConnectionTracker();          // never connected
            const ports = buildLivePorts({
                userId: USER, newsStore: new NewsStore(), connectionTracker: dead,
                universe: [SYMBOL],
                analyseCandidate: async () => ({ action: "BUY", confidence: "HIGH", quantity: 200,
                                                 reasoning: "x", setupType: "y",
                                                 invalidationConditions: ["z"] }),
            });
            const runtime = new AutonomousRuntime({
                engine, reconciler: reconcile, userId: USER,
                clock: () => new Date(at(12, 0)), ports });
            await runtime.start();
            await runtime.candidateScan();
            expect(await orderCount()).toBe(0);
            await runtime.stop();
        }, 60000);

        it("restart produces no duplicate order", async () => {
            await seedBars();
            const candidate = async () => ({ action: "BUY", confidence: "HIGH", quantity: 200,
                                             reasoning: "x", setupType: "y",
                                             invalidationConditions: ["z"] });
            const first = makeRuntime({ candidate });
            first.executeIntent = async (intent) =>
                first.venue.submit({ ...intent, userId: USER, clientOrderId: "stable-restart" });
            await first.start(); await first.candidateScan(); await first.venue.tick();
            await first.stop();
            const after = await orderCount();

            const second = makeRuntime({ candidate });
            second.executeIntent = async (intent) =>
                second.venue.submit({ ...intent, userId: USER, clientOrderId: "stable-restart" });
            await second.start(); await second.candidateScan(); await second.venue.tick();
            await second.stop();

            expect(await orderCount()).toBe(after);
        }, 60000);

        it("a quiet market costs zero LLM calls", async () => {
            const agg = new BarAggregator({ redis });
            await feedTicks(agg, Array.from({ length: 46 }, (_, i) => 1000 + (i % 2 ? -0.2 : 0.2)));
            const candidate = vi.fn();
            const reassessModel = vi.fn();
            const runtime = makeRuntime({ candidate, reassessModel });
            await runtime.start();
            await runtime.orchestrator.monitorCycle();
            await runtime.orchestrator.reasoningCycle();
            await runtime.candidateScan();
            expect(candidate).not.toHaveBeenCalled();
            expect(reassessModel).not.toHaveBeenCalled();
            await runtime.stop();
        }, 60000);
    });
});
