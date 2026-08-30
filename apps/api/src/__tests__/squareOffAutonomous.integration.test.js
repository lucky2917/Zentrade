import { afterAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// The 15:25 IST square-off is the last thing that touches an intraday paper
// position. Migration 026 made orders.state NOT NULL with no default, and the
// square-off INSERT did not supply it, so every close failed and rolled back.

describe.skipIf(!TEST_DB || !TEST_REDIS)("end-of-day square-off closes autonomous positions", () => {
    let pool, redis, engine, squareOffAll;
    const USER = 8486;
    const SYMBOL = "RELIANCE";

    beforeEach(async () => {
        ({ pool } = await import("../config/db.js"));
        ({ default: redis } = await import("../config/redis.js"));
        engine = await import("../services/execution/engine.js");
        ({ squareOffAll } = await import("../services/squareOff.js"));

        await pool.query("DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'squareoff@test',500000000)
             ON CONFLICT (id) DO UPDATE SET balance_paise=500000000`, [USER]);
        await redis.del(`stock:${SYMBOL}`);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    it("closes an INTRADAY paper position instead of failing on the state column", async () => {
        const { order } = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side: "BUY", quantity: 100,
            pricePaise: 100000, mode: "INTRADAY",
            clientOrderId: "sq-1", correlationId: "sq" });
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        await engine.applyFill({ orderId: order.id, executionRef: "f1",
                                 quantity: 100, pricePaise: 100000 });

        const held = await pool.query(
            "SELECT quantity, order_mode FROM portfolio WHERE user_id=$1 AND symbol=$2", [USER, SYMBOL]);
        expect(Number(held.rows[0].quantity)).toBe(100);
        expect(held.rows[0].order_mode).toBe("INTRADAY");

        // A fresh price, as the websocket would have left it.
        await redis.set(`stock:${SYMBOL}`, JSON.stringify({
            symbol: SYMBOL, price: 1050, timestamp: Date.now() }));

        await squareOffAll();

        const after = await pool.query(
            "SELECT quantity FROM portfolio WHERE user_id=$1 AND symbol=$2", [USER, SYMBOL]);
        expect(after.rows).toHaveLength(0);

        const sells = await pool.query(
            "SELECT state, filled_quantity, type FROM orders WHERE user_id=$1 AND type='SELL'", [USER]);
        expect(sells.rows).toHaveLength(1);
        expect(sells.rows[0].state).toBe("FILLED");
        expect(Number(sells.rows[0].filled_quantity)).toBe(100);
    }, 60000);

    it("skips a position whose price is stale rather than closing at a guess", async () => {
        const { order } = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side: "BUY", quantity: 100,
            pricePaise: 100000, mode: "INTRADAY",
            clientOrderId: "sq-2", correlationId: "sq" });
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        await engine.applyFill({ orderId: order.id, executionRef: "f1",
                                 quantity: 100, pricePaise: 100000 });

        await redis.set(`stock:${SYMBOL}`, JSON.stringify({
            symbol: SYMBOL, price: 1050, timestamp: Date.now() - 6 * 60 * 60 * 1000 }));

        await squareOffAll();

        const after = await pool.query(
            "SELECT quantity FROM portfolio WHERE user_id=$1 AND symbol=$2", [USER, SYMBOL]);
        expect(Number(after.rows[0].quantity)).toBe(100);
    }, 60000);
});
