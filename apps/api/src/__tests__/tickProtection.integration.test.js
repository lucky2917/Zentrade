import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// F3. The acceptance test for the corrected timing model.
//
// A stop is a pre-commitment made at entry. The tick that crosses it must
// produce a protective order, and no language model may sit between the two.

describe.skipIf(!TEST_DB || !TEST_REDIS)("tick-level protection", () => {
    let pool, redis, engine, reconcile, AutonomousRuntime, buildLivePorts;
    let NewsStore, ConnectionTracker;
    const USER = 8496;
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
        await pool.query("DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM trade_thesis WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'reflex@test',500000000)
             ON CONFLICT (id) DO UPDATE SET balance_paise=500000000`, [USER]);
        await redis.del(`stock:${SYMBOL}`);
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

    const seedPosition = async ({ stop = 98_000, target = 108_000 } = {}) => {
        const { order } = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side: "BUY", quantity: 200,
            pricePaise: 100_000, mode: "INTRADAY",
            clientOrderId: `seed-${Date.now()}`, correlationId: "seed" });
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        await engine.applyFill({ orderId: order.id, executionRef: "f1",
                                 quantity: 200, pricePaise: 100_000 });
        const { rows: [thesis] } = await pool.query(
            `INSERT INTO trade_thesis (user_id, symbol, correlation_id, side, entry_price_paise,
                quantity, rationale, setup_type, invalidation_conditions, supporting_evidence,
                horizon, stop_paise, target_paise)
             VALUES ($1,$2,'seed','BUY',100000,200,'breakout','breakout',
                     '["close below 980"]'::jsonb,'[]'::jsonb,'INTRADAY',$3,$4)
             RETURNING *`, [USER, SYMBOL, stop, target]);
        return thesis;
    };

    const makeRuntime = ({ analyse = null, reassess = null } = {}) => {
        const tracker = new ConnectionTracker();
        tracker.onConnecting(); tracker.onConnected(); tracker.onTick(at(12, 0));
        const ports = buildLivePorts({
            userId: USER, newsStore: new NewsStore(), connectionTracker: tracker,
            universe: [SYMBOL], analyseCandidate: analyse, callModel: reassess });
        return new AutonomousRuntime({
            engine, reconciler: reconcile, userId: USER,
            clock: () => new Date(at(12, 0)), ports });
    };

    it("THE ACCEPTANCE TEST: a tick crossing the stop produces an order before any model call", async () => {
        await seedPosition({ stop: 98_000 });

        const modelCalls = [];
        const reassess = vi.fn(async (ctx) => {
            modelCalls.push({ at: Date.now(), ctx });
            return { action: "EXIT", confidence: "HIGH", thesisStillValid: false,
                     whatChanged: "stop breached", material: true, reasoning: "gone" };
        });
        const runtime = makeRuntime({ reassess });
        await runtime.start();
        expect(runtime.reflex.isArmed(SYMBOL)).toBe(true);

        // Ticks inside the level do nothing.
        runtime.ingestTick({ symbol: SYMBOL, price: 981, timestamp: at(12, 0) });
        runtime.ingestTick({ symbol: SYMBOL, price: 980.5, timestamp: at(12, 0) });
        expect(await holding()).toBe(200);
        expect(reassess).not.toHaveBeenCalled();

        // The tick that crosses.
        const crossings = runtime.ingestTick({ symbol: SYMBOL, price: 979.9, timestamp: at(12, 0) });
        expect(crossings).toHaveLength(1);
        expect(crossings[0].kind).toBe("STOP");

        // Let the fire-and-forget protective action settle.
        await vi.waitFor(async () => expect(await holding()).toBe(0), { timeout: 5000 });

        // The protective order exists, and the model was never consulted for it.
        expect(reassess).not.toHaveBeenCalled();
        const { rows: sells } = await pool.query(
            "SELECT state, client_order_id, quantity FROM orders WHERE user_id=$1 AND type='SELL'", [USER]);
        expect(sells).toHaveLength(1);
        expect(sells[0].state).toBe("FILLED");
        expect(sells[0].client_order_id).toMatch(/:PROTECT:STOP$/);
        await runtime.stop();
    }, 60000);

    it("the crossing is handed to reasoning AFTER the position is protected", async () => {
        const thesis = await seedPosition({ stop: 98_000 });
        const runtime = makeRuntime();
        await runtime.start();
        runtime.ingestTick({ symbol: SYMBOL, price: 979, timestamp: at(12, 0) });
        await vi.waitFor(async () => expect(await holding()).toBe(0), { timeout: 5000 });

        // The event exists, is durable, and is queued for the trader to reassess.
        const { rows } = await pool.query(
            `SELECT event_type, severity, state, source, thesis_id FROM position_events
             WHERE user_id=$1 AND source='reflex_lane'`, [USER]);
        expect(rows).toHaveLength(1);
        expect(rows[0].event_type).toBe("STOP_BREACH");
        expect(rows[0].severity).toBe("CRITICAL");
        expect(rows[0].thesis_id).toBe(thesis.id);
        expect(runtime.orchestrator.queue.size).toBeGreaterThan(0);
        await runtime.stop();
    }, 60000);

    it("does not protect twice when price keeps falling", async () => {
        await seedPosition({ stop: 98_000 });
        const runtime = makeRuntime();
        await runtime.start();
        for (const price of [979, 975, 970, 960, 950]) {
            runtime.ingestTick({ symbol: SYMBOL, price, timestamp: at(12, 0) });
        }
        await vi.waitFor(async () => expect(await holding()).toBe(0), { timeout: 5000 });
        const { rows } = await pool.query(
            "SELECT COUNT(*)::int n FROM orders WHERE user_id=$1 AND type='SELL'", [USER]);
        expect(rows[0].n).toBe(1);
        await runtime.stop();
    }, 60000);

    it("a target reach is handed to the trader rather than exited automatically", async () => {
        await seedPosition({ target: 108_000 });
        const runtime = makeRuntime();
        await runtime.start();
        runtime.ingestTick({ symbol: SYMBOL, price: 1085, timestamp: at(12, 0) });
        // Counted as a material signal, not a protective action: only a stop or
        // a named invalidation authorises moving the position.
        await vi.waitFor(() => expect(runtime.metrics.materialSignals).toBe(1), { timeout: 5000 });
        expect(runtime.metrics.protectiveActions).toBe(0);
        // Still held: reaching a target is a judgement, not a pre-commitment.
        expect(await holding()).toBe(200);
        const { rows } = await pool.query(
            "SELECT event_type FROM position_events WHERE user_id=$1 AND source='reflex_lane'", [USER]);
        expect(rows[0].event_type).toBe("TARGET_BREACH");
        await runtime.stop();
    }, 60000);

    it("a restart re-arms every open position before the next tick", async () => {
        await seedPosition({ stop: 98_000 });
        const first = makeRuntime();
        await first.start();
        await first.stop();

        const second = makeRuntime();
        await second.start();
        expect(second.reflex.isArmed(SYMBOL)).toBe(true);
        second.ingestTick({ symbol: SYMBOL, price: 970, timestamp: at(12, 0) });
        await vi.waitFor(async () => expect(await holding()).toBe(0), { timeout: 5000 });
        await second.stop();
    }, 60000);

    it("protects only what is actually still held", async () => {
        await seedPosition({ stop: 98_000 });
        const runtime = makeRuntime();
        await runtime.start();
        // Something else sold half before the crossing.
        const { order } = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side: "SELL", quantity: 100, pricePaise: 100_000,
            mode: "INTRADAY", clientOrderId: "manual-half", correlationId: "manual" });
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        await engine.applyFill({ orderId: order.id, executionRef: "h1",
                                 quantity: 100, pricePaise: 100_000 });

        runtime.ingestTick({ symbol: SYMBOL, price: 979, timestamp: at(12, 0) });
        await vi.waitFor(async () => expect(await holding()).toBe(0), { timeout: 5000 });
        const { rows } = await pool.query(
            "SELECT quantity FROM orders WHERE user_id=$1 AND type='SELL' AND client_order_id LIKE '%PROTECT%'", [USER]);
        expect(Number(rows[0].quantity)).toBe(100);
        await runtime.stop();
    }, 60000);

    it("a position closed by something else disarms instead of erroring", async () => {
        await seedPosition({ stop: 98_000 });
        const runtime = makeRuntime();
        await runtime.start();
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        runtime.ingestTick({ symbol: SYMBOL, price: 979, timestamp: at(12, 0) });
        await vi.waitFor(() => expect(runtime.reflex.isArmed(SYMBOL)).toBe(false), { timeout: 5000 });
        await runtime.stop();
    }, 60000);
});
