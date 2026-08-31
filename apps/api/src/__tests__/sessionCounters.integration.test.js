import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// What the session budgets are counting.
//
// The risk gate stops trading at 20 trades and at a turnover ceiling. Those
// counters were built from every order row regardless of outcome, so an order
// the venue rejected — which is not a trade, cost nothing and moved nothing —
// spent the session's trade budget and its turnover allowance. Twenty
// rejections in a volatile open would have closed the book for the day with
// nothing having happened.

describe.skipIf(!TEST_DB || !TEST_REDIS)("session budgets count what happened", () => {
    let pool, redis, engine, ports;
    const USER = 8496;
    const SYMBOL = "TCS";
    const PRICE = 300_000;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        ({ default: redis } = await import("../config/redis.js"));
        engine = await import("../services/execution/engine.js");
        const { buildLivePorts } = await import("../services/autonomous/livePorts.js");
        ports = buildLivePorts({ userId: USER, newsStore: null, connectionTracker: null });
    });

    beforeEach(async () => {
        await pool.query(
            "DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)",
            [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'counters@test',100000000)
             ON CONFLICT (id) DO UPDATE SET balance_paise=100000000`, [USER]);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const submit = async (ref, quantity = 10) => {
        const { order } = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side: "BUY", quantity, pricePaise: PRICE,
            mode: "INTRADAY", clientOrderId: ref, correlationId: ref });
        return order;
    };

    it("counts nothing before anything has traded", async () => {
        expect(await ports.sessionCounters()).toEqual({
            trades: 0, turnoverPaise: 0, realisedLossPaise: 0 });
    });

    it("does not count an order the venue rejected", async () => {
        const order = await submit("rej-1");
        await engine.rejectOrder(order.id, "venue said no");

        const counters = await ports.sessionCounters();
        expect(counters.trades).toBe(0);
        expect(counters.turnoverPaise).toBe(0);
    });

    it("does not count an order that was cancelled before it filled", async () => {
        const order = await submit("can-1");
        await engine.acceptOrder(order.id);
        await engine.cancelOrder(order.id);
        expect((await ports.sessionCounters()).trades).toBe(0);
    });

    it("does not count an order still resting on the book", async () => {
        const order = await submit("open-1");
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        expect((await ports.sessionCounters()).trades).toBe(0);
    });

    it("counts a filled order once, at the value that actually filled", async () => {
        const order = await submit("fill-1", 10);
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        await engine.applyFill({ orderId: order.id, executionRef: "f1",
                                 quantity: 10, pricePaise: PRICE });

        const counters = await ports.sessionCounters();
        expect(counters.trades).toBe(1);
        expect(counters.turnoverPaise).toBe(10 * PRICE);
    });

    it("counts only the filled part of a partly filled order", async () => {
        const order = await submit("part-1", 10);
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        await engine.applyFill({ orderId: order.id, executionRef: "p1",
                                 quantity: 4, pricePaise: PRICE });
        await engine.expireOrder(order.id);

        const counters = await ports.sessionCounters();
        // It traded, so it counts as a trade — for four shares, not ten.
        expect(counters.trades).toBe(1);
        expect(counters.turnoverPaise).toBe(4 * PRICE);
    });

    it("still counts a realised loss the moment it is booked", async () => {
        const buy = await submit("loss-buy", 10);
        await engine.acceptOrder(buy.id);
        await engine.workOrder(buy.id);
        await engine.applyFill({ orderId: buy.id, executionRef: "b1",
                                 quantity: 10, pricePaise: PRICE });

        const { order: sell } = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side: "SELL", quantity: 10,
            pricePaise: PRICE - 1_000, mode: "INTRADAY",
            clientOrderId: "loss-sell", correlationId: "loss-sell" });
        await engine.acceptOrder(sell.id);
        await engine.workOrder(sell.id);
        await engine.applyFill({ orderId: sell.id, executionRef: "s1",
                                 quantity: 10, pricePaise: PRICE - 1_000 });

        const counters = await ports.sessionCounters();
        expect(counters.trades).toBe(2);
        expect(counters.realisedLossPaise).toBe(10_000);
    });
});
