import { afterAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// F1/F2. The paper account has one ledger or it has none.
//
// Two money models existed: the execution engine debited the full gross on a
// BUY and never recorded margin, while the legacy square-off credited
// margin + pnl. Each was internally consistent. Together they destroyed the
// principal on every position the brain did not close itself.

describe.skipIf(!TEST_DB || !TEST_REDIS)("ledger conservation", () => {
    let pool, redis, engine, squareOffAll, ledger;
    const USER = 8490;
    const SYMBOL = "RELIANCE";
    const START = 100_000_000;          // Rs 10,00,000

    beforeEach(async () => {
        ({ pool } = await import("../config/db.js"));
        ({ default: redis } = await import("../config/redis.js"));
        engine = await import("../services/execution/engine.js");
        ({ squareOffAll } = await import("../services/squareOff.js"));
        ledger = await import("../services/execution/ledger.js");

        await pool.query("DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'ledger@test',$2)
             ON CONFLICT (id) DO UPDATE SET balance_paise=$2`, [USER, START]);
        await redis.del(`stock:${SYMBOL}`);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const balance = async () => Number(
        (await pool.query("SELECT balance_paise FROM users WHERE id=$1", [USER])).rows[0].balance_paise);

    const holding = async () => {
        const { rows } = await pool.query(
            "SELECT quantity, avg_price_paise, margin_used_paise FROM portfolio WHERE user_id=$1 AND symbol=$2",
            [USER, SYMBOL]);
        return rows[0] ?? null;
    };

    const fill = async ({ side, quantity, pricePaise, ref }) => {
        const { order } = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side, quantity, pricePaise, mode: "INTRADAY",
            clientOrderId: `led-${ref}`, correlationId: "led" });
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        await engine.applyFill({ orderId: order.id, executionRef: ref, quantity, pricePaise });
        return order;
    };

    it("a BUY debits margin plus brokerage, not the full notional", async () => {
        const before = await balance();
        await fill({ side: "BUY", quantity: 200, pricePaise: 100_000, ref: "b1" });
        const debited = before - await balance();
        expect(debited).toBe(ledger.buyDebitPaise({
            quantity: 200, pricePaise: 100_000, mode: "INTRADAY" }));
        expect(debited).toBeLessThan(100_000 * 200);        // not the notional
    });

    it("the reservation covers the debit, never the other way round", async () => {
        const reserved = ledger.buyObligationPaise({ quantity: 200, pricePaise: 100_000, mode: "INTRADAY" });
        const before = await balance();
        await fill({ side: "BUY", quantity: 200, pricePaise: 100_000, ref: "b1" });
        expect(reserved).toBeGreaterThanOrEqual(before - await balance());
    });

    it("a BUY records the margin it consumed, excluding brokerage", async () => {
        await fill({ side: "BUY", quantity: 200, pricePaise: 100_000, ref: "b1" });
        const held = await holding();
        expect(Number(held.margin_used_paise)).toBe(
            ledger.buyMarginPaise({ quantity: 200, pricePaise: 100_000, mode: "INTRADAY" }));
    });

    it("engine buy then engine sell conserves cash to the paise on a flat trade", async () => {
        await fill({ side: "BUY", quantity: 200, pricePaise: 100_000, ref: "b1" });
        await fill({ side: "SELL", quantity: 200, pricePaise: 100_000, ref: "s1" });
        // Two brokerage charges, nothing else.
        expect(await balance()).toBe(START - 2 * ledger.BROKERAGE_PAISE);
    });

    it("engine buy then LEGACY square-off conserves cash to the paise", async () => {
        await fill({ side: "BUY", quantity: 200, pricePaise: 100_000, ref: "b1" });
        await redis.set(`stock:${SYMBOL}`, JSON.stringify({
            symbol: SYMBOL, price: 1000, timestamp: Date.now() }));
        await squareOffAll();
        expect(await holding()).toBeNull();
        // SELL_SPREAD makes the exit fractionally worse than the entry; the
        // point is that the principal comes back, not that it is free.
        const end = await balance();
        expect(START - end).toBeLessThan(300_000);   // costs only, not Rs 2,00,000
        expect(end).toBeGreaterThan(START - 300_000);
    });

    it("a profitable round trip returns principal plus profit", async () => {
        await fill({ side: "BUY", quantity: 200, pricePaise: 100_000, ref: "b1" });
        await fill({ side: "SELL", quantity: 200, pricePaise: 110_000, ref: "s1" });
        const profit = (110_000 - 100_000) * 200;
        expect(await balance()).toBe(START + profit - 2 * ledger.BROKERAGE_PAISE);
    });

    it("a losing round trip removes exactly the loss", async () => {
        await fill({ side: "BUY", quantity: 200, pricePaise: 100_000, ref: "b1" });
        await fill({ side: "SELL", quantity: 200, pricePaise: 95_000, ref: "s1" });
        const loss = (100_000 - 95_000) * 200;
        expect(await balance()).toBe(START - loss - 2 * ledger.BROKERAGE_PAISE);
    });

    it("partial exits release margin proportionally", async () => {
        await fill({ side: "BUY", quantity: 200, pricePaise: 100_000, ref: "b1" });
        const openMargin = Number((await holding()).margin_used_paise);
        await fill({ side: "SELL", quantity: 100, pricePaise: 100_000, ref: "s1" });
        const left = await holding();
        expect(Number(left.quantity)).toBe(100);
        expect(Number(left.margin_used_paise)).toBe(Math.round(openMargin / 2));
    });

    it("the reservation can never understate what the fill actually takes", async () => {
        for (const [qty, price] of [[1, 100_000], [7, 33_333], [200, 100_000], [999, 12_345]]) {
            const reserved = ledger.buyObligationPaise({ quantity: qty, pricePaise: price, mode: "INTRADAY" });
            const debited = ledger.buyDebitPaise({ quantity: qty, pricePaise: price, mode: "INTRADAY" });
            expect(reserved).toBeGreaterThanOrEqual(debited);
        }
    });

    it("cash cannot be driven negative by filling to the reservation limit", async () => {
        // Five positions each reserving a fifth of the account.
        const symbols = ["TCS", "INFY", "WIPRO", "HCLTECH", "TECHM"];
        for (const [i, sym] of symbols.entries()) {
            const { order } = await engine.submitOrder({
                userId: USER, symbol: sym, side: "BUY", quantity: 100, pricePaise: 100_000,
                mode: "INTRADAY", clientOrderId: `sat-${i}`, correlationId: "sat" });
            await engine.acceptOrder(order.id);
            await engine.workOrder(order.id);
            await engine.applyFill({ orderId: order.id, executionRef: `sat-${i}`,
                                     quantity: 100, pricePaise: 100_000 });
        }
        expect(await balance()).toBeGreaterThanOrEqual(0);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
    });
});
