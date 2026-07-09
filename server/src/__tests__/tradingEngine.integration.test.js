import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Integration test for the buy/sell path against a real (throwaway) Postgres.
// Skipped unless TEST_DATABASE_URL is set, e.g.:
//   createdb zentrade_test
//   TEST_DATABASE_URL=postgresql://localhost:5432/zentrade_test npm test
// CI provides a postgres service and sets this automatically.
const TEST_DB = process.env.TEST_DATABASE_URL;

// Redis is faked with an in-memory map — the engine only reads price keys.
vi.mock("../config/redis.js", () => {
    const store = new Map();
    return {
        default: {
            get: async (key) => store.get(key) ?? null,
            set: async (key, value) => { store.set(key, value); return "OK"; },
            setex: async (key, _ttl, value) => { store.set(key, value); return "OK"; },
            del: async (key) => store.delete(key),
            __store: store,
        },
    };
});

const BROKERAGE = 2000; // paise, mirrors tradingEngine
const START_BALANCE = 100000000; // ₹10L in paise

describe.skipIf(!TEST_DB)("trading engine (integration, throwaway Postgres)", () => {
    let pool, executeBuy, executeSell, redis;

    const setPrice = (symbol, price) =>
        redis.set(`stock:${symbol}`, JSON.stringify({ price, timestamp: Date.now() }));

    const createUser = async (email) => {
        const { rows } = await pool.query(
            "INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id",
            [email]
        );
        return rows[0].id;
    };

    const getBalance = async (userId) => {
        const { rows } = await pool.query("SELECT balance_paise FROM users WHERE id = $1", [userId]);
        return Number(rows[0].balance_paise);
    };

    const getHolding = async (userId, symbol, mode) => {
        const { rows } = await pool.query(
            "SELECT quantity, avg_price_paise, margin_used_paise FROM portfolio WHERE user_id = $1 AND symbol = $2 AND order_mode = $3",
            [userId, symbol, mode]
        );
        return rows[0] ?? null;
    };

    beforeAll(async () => {
        process.env.DATABASE_URL = TEST_DB;
        ({ pool } = await import("../config/db.js"));
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        ({ executeBuy, executeSell } = await import("../services/tradingEngine.js"));
        redis = (await import("../config/redis.js")).default;
    });

    beforeEach(async () => {
        await pool.query("TRUNCATE users, portfolio, orders, watchlist RESTART IDENTITY CASCADE");
        redis.__store.clear();
    });

    afterAll(async () => {
        await pool?.end();
    });

    it("DELIVERY buy debits cost + brokerage and creates the holding", async () => {
        const userId = await createUser("buy@test.com");
        await setPrice("RELIANCE", 1000); // exec = 1000 * 1.001 * 100 = 100100 paise

        const result = await executeBuy(userId, "RELIANCE", 10, "DELIVERY");

        expect(result.executionPricePaise).toBe(100100);
        expect(result.stockCostPaise).toBe(1001000);
        expect(await getBalance(userId)).toBe(START_BALANCE - 1001000 - BROKERAGE);

        const holding = await getHolding(userId, "RELIANCE", "DELIVERY");
        expect(holding.quantity).toBe(10);
        expect(Number(holding.avg_price_paise)).toBe(100100);
    });

    it("second buy averages the price correctly", async () => {
        const userId = await createUser("avg@test.com");
        await setPrice("RELIANCE", 1000);
        await executeBuy(userId, "RELIANCE", 10, "DELIVERY"); // avg 100100
        await setPrice("RELIANCE", 2000);
        await executeBuy(userId, "RELIANCE", 10, "DELIVERY"); // exec 200200

        const holding = await getHolding(userId, "RELIANCE", "DELIVERY");
        expect(holding.quantity).toBe(20);
        // (10*100100 + 10*200200) / 20 = 150150
        expect(Number(holding.avg_price_paise)).toBe(150150);
    });

    it("DELIVERY sell credits proceeds minus brokerage and records pnl", async () => {
        const userId = await createUser("sell@test.com");
        await setPrice("RELIANCE", 1000);
        await executeBuy(userId, "RELIANCE", 10, "DELIVERY");
        const balanceAfterBuy = await getBalance(userId);

        await setPrice("RELIANCE", 1100); // sell exec = 1100 * 0.999 * 100 = 109890
        const result = await executeSell(userId, "RELIANCE", 4, "DELIVERY");

        expect(result.executionPricePaise).toBe(109890);
        expect(result.pnlPaise).toBe((109890 - 100100) * 4);
        expect(result.creditPaise).toBe(109890 * 4 - BROKERAGE);
        expect(await getBalance(userId)).toBe(balanceAfterBuy + result.creditPaise);

        const holding = await getHolding(userId, "RELIANCE", "DELIVERY");
        expect(holding.quantity).toBe(6);

        const { rows } = await pool.query(
            "SELECT pnl_paise FROM orders WHERE user_id = $1 AND type = 'SELL'", [userId]
        );
        expect(Number(rows[0].pnl_paise)).toBe(result.pnlPaise);
    });

    it("selling the full position deletes the holding row", async () => {
        const userId = await createUser("full@test.com");
        await setPrice("RELIANCE", 500);
        await executeBuy(userId, "RELIANCE", 3, "DELIVERY");
        await executeSell(userId, "RELIANCE", 3, "DELIVERY");

        expect(await getHolding(userId, "RELIANCE", "DELIVERY")).toBeNull();
    });

    it("INTRADAY buy takes 1/5 margin but full brokerage", async () => {
        const userId = await createUser("mis@test.com");
        await setPrice("RELIANCE", 1000);

        const result = await executeBuy(userId, "RELIANCE", 10, "INTRADAY");

        const expectedMargin = Math.ceil(1001000 / 5) + BROKERAGE;
        expect(result.marginRequiredPaise).toBe(expectedMargin);
        expect(await getBalance(userId)).toBe(START_BALANCE - expectedMargin);
    });

    it("INTRADAY sell returns margin plus pnl minus brokerage, losses go through", async () => {
        const userId = await createUser("misloss@test.com");
        await setPrice("RELIANCE", 1000);
        const buy = await executeBuy(userId, "RELIANCE", 10, "INTRADAY");
        const balanceAfterBuy = await getBalance(userId);

        await setPrice("RELIANCE", 900); // losing trade: exec = 89910
        const result = await executeSell(userId, "RELIANCE", 10, "INTRADAY");

        const expectedPnl = (89910 - 100100) * 10; // negative
        expect(result.pnlPaise).toBe(expectedPnl);
        expect(result.creditPaise).toBe(buy.marginRequiredPaise + expectedPnl - BROKERAGE);
        expect(await getBalance(userId)).toBe(balanceAfterBuy + result.creditPaise);
        expect(await getHolding(userId, "RELIANCE", "INTRADAY")).toBeNull();
    });

    it("rejects a buy the balance cannot cover", async () => {
        const userId = await createUser("poor@test.com");
        await pool.query("UPDATE users SET balance_paise = 1000 WHERE id = $1", [userId]);
        await setPrice("RELIANCE", 1000);

        await expect(executeBuy(userId, "RELIANCE", 1, "DELIVERY")).rejects.toThrow(/Insufficient/);
        expect(await getBalance(userId)).toBe(1000); // nothing debited
    });

    it("rejects selling more than held", async () => {
        const userId = await createUser("overshort@test.com");
        await setPrice("RELIANCE", 1000);
        await executeBuy(userId, "RELIANCE", 2, "DELIVERY");

        await expect(executeSell(userId, "RELIANCE", 5, "DELIVERY")).rejects.toThrow("Insufficient holdings");
    });

    it("rejects unknown symbols and stale prices", async () => {
        const userId = await createUser("badsym@test.com");
        await expect(executeBuy(userId, "NOTREAL", 1, "DELIVERY")).rejects.toThrow("Invalid stock symbol");

        await redis.set("stock:RELIANCE", JSON.stringify({ price: 1000, timestamp: Date.now() - 9 * 60 * 60 * 1000 }));
        await expect(executeBuy(userId, "RELIANCE", 1, "DELIVERY")).rejects.toThrow(/stale/i);
    });

    it("concurrent buys both land, quantities and balance stay consistent", async () => {
        const userId = await createUser("race@test.com");
        await setPrice("RELIANCE", 1000);

        await Promise.all([
            executeBuy(userId, "RELIANCE", 5, "DELIVERY"),
            executeBuy(userId, "RELIANCE", 7, "DELIVERY"),
        ]);

        const holding = await getHolding(userId, "RELIANCE", "DELIVERY");
        expect(holding.quantity).toBe(12);
        // 12 shares at exec 100100 + 2 brokerages
        expect(await getBalance(userId)).toBe(START_BALANCE - 12 * 100100 - 2 * BROKERAGE);
    });
});
