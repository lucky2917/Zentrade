import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// G2 end to end. A material change that is not a pre-commitment must reach the
// attention queue on the tick that causes it, without waiting for the
// supervisory sweep and without calling a model to notice it.

describe.skipIf(!TEST_DB || !TEST_REDIS)("continuous material-change detection", () => {
    let pool, redis, engine, reconcile, AutonomousRuntime, buildLivePorts;
    let NewsStore, ConnectionTracker;
    const USER = 8498;
    const SYMBOL = "RELIANCE";
    const at = (h, m) => Date.UTC(2026, 7, 31, 0, h * 60 + m - 330, 0);

    beforeEach(async () => {
        ({ pool } = await import("../config/db.js"));
        ({ default: redis } = await import("../config/redis.js"));
        engine = await import("../services/execution/engine.js");
        reconcile = await import("../services/execution/reconcile.js");
        ({ AutonomousRuntime } = await import("../services/autonomous/runtime.js"));
        ({ buildLivePorts } = await import("../services/autonomous/livePorts.js"));
        ({ NewsStore } = await import("../services/news/ingest.js"));
        ({ ConnectionTracker } = await import("../services/orchestrator/connectionState.js"));

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
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'cont@test',500000000)
             ON CONFLICT (id) DO UPDATE SET balance_paise=500000000`, [USER]);
        await redis.del(`stock:${SYMBOL}`);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const seedPosition = async () => {
        const { order } = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side: "BUY", quantity: 200,
            pricePaise: 100_000, mode: "INTRADAY",
            clientOrderId: `c-${Date.now()}`, correlationId: "cont" });
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        await engine.applyFill({ orderId: order.id, executionRef: "f1",
                                 quantity: 200, pricePaise: 100_000 });
        const { rows: [thesis] } = await pool.query(
            `INSERT INTO trade_thesis (user_id, symbol, correlation_id, side, entry_price_paise,
                quantity, rationale, setup_type, invalidation_conditions, supporting_evidence,
                horizon, stop_paise, target_paise)
             VALUES ($1,$2,'cont','BUY',100000,200,'breakout','breakout',
                     '["close below 980"]'::jsonb,'[]'::jsonb,'INTRADAY',98000,108000)
             RETURNING *`, [USER, SYMBOL]);
        return thesis;
    };

    const makeRuntime = (reassess = null) => {
        const tracker = new ConnectionTracker();
        tracker.onConnecting(); tracker.onConnected(); tracker.onTick(at(12, 0));
        const ports = buildLivePorts({
            userId: USER, newsStore: new NewsStore(), connectionTracker: tracker,
            universe: [SYMBOL], callModel: reassess });
        return new AutonomousRuntime({
            engine, reconciler: reconcile, userId: USER,
            clock: () => new Date(at(12, 0)), ports });
    };

    const events = async () => (await pool.query(
        `SELECT event_type, severity, source, state FROM position_events
         WHERE user_id=$1 AND source='reflex_lane' ORDER BY created_at`, [USER])).rows;

    it("a position is armed AND watched on start", async () => {
        await seedPosition();
        const runtime = makeRuntime();
        await runtime.start();
        expect(runtime.reflex.isArmed(SYMBOL)).toBe(true);
        expect(runtime.reflex.isWatched(SYMBOL)).toBe(true);
        await runtime.stop();
    }, 60000);

    it("THE GAP CLOSED: entering the stop band raises an event on the tick", async () => {
        const thesis = await seedPosition();
        const model = vi.fn();
        const runtime = makeRuntime(model);
        await runtime.start();

        // Entry 1000, stop 980. Within 25% of the span means at or below 985.
        runtime.ingestTick({ symbol: SYMBOL, price: 990, timestamp: at(12, 0) });
        expect(await events()).toHaveLength(0);

        runtime.ingestTick({ symbol: SYMBOL, price: 984, timestamp: at(12, 0) });
        await vi.waitFor(async () => expect(await events()).toHaveLength(1), { timeout: 5000 });

        const [event] = await events();
        expect(event.event_type).toBe("STOP_APPROACHING");
        expect(event.severity).toBe("WARNING");
        expect(event.state).toBe("PENDING");     // queued for the trader

        // Detection is deterministic: no model was consulted to notice this.
        expect(model).not.toHaveBeenCalled();
        // And it did not move the position.
        const { rows } = await pool.query(
            "SELECT quantity FROM portfolio WHERE user_id=$1 AND symbol=$2", [USER, SYMBOL]);
        expect(Number(rows[0].quantity)).toBe(200);
        expect(runtime.orchestrator.queue.size).toBeGreaterThan(0);
        await runtime.stop();
    }, 60000);

    it("a price jump that reverses within one sweep interval is still caught", async () => {
        await seedPosition();
        const runtime = makeRuntime();
        await runtime.start();

        // A 15-second poll sampling the endpoints would see 1000 then 1000.
        runtime.ingestTick({ symbol: SYMBOL, price: 1000, timestamp: at(12, 0) });
        runtime.ingestTick({ symbol: SYMBOL, price: 1035, timestamp: at(12, 0) + 7_000 });
        runtime.ingestTick({ symbol: SYMBOL, price: 1000, timestamp: at(12, 0) + 14_000 });

        await vi.waitFor(async () => {
            const rows = await events();
            expect(rows.some((r) => r.event_type === "PRICE_JUMP")).toBe(true);
        }, { timeout: 5000 });
        await runtime.stop();
    }, 60000);

    it("a stop breach still protects, and is not merely reported", async () => {
        await seedPosition();
        const runtime = makeRuntime();
        await runtime.start();
        runtime.ingestTick({ symbol: SYMBOL, price: 979, timestamp: at(12, 0) });

        await vi.waitFor(async () => {
            const { rows } = await pool.query(
                "SELECT quantity FROM portfolio WHERE user_id=$1 AND symbol=$2", [USER, SYMBOL]);
            expect(rows).toHaveLength(0);
        }, { timeout: 5000 });

        expect(runtime.metrics.protectiveExits).toBe(1);
        await runtime.stop();
    }, 60000);

    it("signals do not move the position; only pre-commitments do", async () => {
        await seedPosition();
        const runtime = makeRuntime();
        await runtime.start();
        runtime.ingestTick({ symbol: SYMBOL, price: 1000, timestamp: at(12, 0) });
        runtime.ingestTick({ symbol: SYMBOL, price: 984, timestamp: at(12, 0) + 1000 });
        runtime.ingestTick({ symbol: SYMBOL, price: 1035, timestamp: at(12, 0) + 2000 });

        await vi.waitFor(() => expect(runtime.metrics.materialSignals).toBeGreaterThan(0),
                         { timeout: 5000 });
        expect(runtime.metrics.protectiveExits).toBe(0);
        const { rows } = await pool.query(
            "SELECT COUNT(*)::int n FROM orders WHERE user_id=$1 AND type='SELL'", [USER]);
        expect(rows[0].n).toBe(0);
        await runtime.stop();
    }, 60000);

    it("a repeated condition does not re-queue on every tick", async () => {
        await seedPosition();
        const runtime = makeRuntime();
        await runtime.start();
        for (let i = 0; i < 40; i += 1) {
            runtime.ingestTick({ symbol: SYMBOL, price: 984 - i * 0.01, timestamp: at(12, 0) + i });
        }
        await vi.waitFor(async () => expect((await events()).length).toBeGreaterThan(0),
                         { timeout: 5000 });
        const approaching = (await events()).filter((r) => r.event_type === "STOP_APPROACHING");
        expect(approaching).toHaveLength(1);
        await runtime.stop();
    }, 60000);
});
