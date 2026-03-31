import { pool } from "../config/db.js";
import redis from "../config/redis.js";
import { toPaise } from "../utils/paise.js";
import { STOCK_MAP } from "../config/stocks.js";
import logger from "../utils/logger.js";

const BROKERAGE_PAISE = 2000;
const BUY_SPREAD = 1.001;
const SELL_SPREAD = 0.999;
const MAX_QUANTITY = 10000;
const MAX_PRICE_AGE_MS = 15000;

const validatePriceData = (priceData, symbol) => {
    if (!priceData) {
        throw new Error("Price not available for " + symbol);
    }

    const parsed = JSON.parse(priceData);
    if (!parsed.price || !parsed.timestamp) {
        throw new Error("Invalid price data for " + symbol);
    }

    const age = Date.now() - parsed.timestamp;
    if (age > MAX_PRICE_AGE_MS) {
        throw new Error("Price data is stale. Please try again.");
    }

    return parsed;
};

const executeBuy = async (userId, symbol, quantity) => {
    if (!STOCK_MAP.has(symbol)) {
        throw new Error("Invalid stock symbol");
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error("Quantity must be a positive integer");
    }

    if (quantity > MAX_QUANTITY) {
        throw new Error("Maximum order quantity is " + MAX_QUANTITY);
    }

    const priceData = await redis.get(`stock:${symbol}`);
    const { price } = validatePriceData(priceData, symbol);

    const executionPrice = Math.round(price * BUY_SPREAD * 100) / 100;
    const executionPricePaise = toPaise(executionPrice);
    const totalCostPaise = executionPricePaise * quantity + BROKERAGE_PAISE;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const userResult = await client.query(
            "SELECT balance_paise FROM users WHERE id = $1 FOR UPDATE",
            [userId]
        );

        if (userResult.rows.length === 0) {
            throw new Error("User not found");
        }

        const balancePaise = Number(userResult.rows[0].balance_paise);
        if (balancePaise < totalCostPaise) {
            throw new Error("Insufficient balance");
        }

        await client.query(
            "UPDATE users SET balance_paise = balance_paise - $1 WHERE id = $2",
            [totalCostPaise, userId]
        );

        const existing = await client.query(
            "SELECT quantity, avg_price_paise FROM portfolio WHERE user_id = $1 AND symbol = $2 FOR UPDATE",
            [userId, symbol]
        );

        if (existing.rows.length > 0) {
            const oldQty = existing.rows[0].quantity;
            const oldAvg = Number(existing.rows[0].avg_price_paise);
            const newAvg = Math.round(((oldQty * oldAvg) + (quantity * executionPricePaise)) / (oldQty + quantity));

            await client.query(
                "UPDATE portfolio SET quantity = quantity + $1, avg_price_paise = $2, updated_at = NOW() WHERE user_id = $3 AND symbol = $4",
                [quantity, newAvg, userId, symbol]
            );
        } else {
            await client.query(
                "INSERT INTO portfolio (user_id, symbol, quantity, avg_price_paise) VALUES ($1, $2, $3, $4)",
                [userId, symbol, quantity, executionPricePaise]
            );
        }

        await client.query(
            "INSERT INTO orders (user_id, symbol, type, quantity, price_paise, total_value_paise, brokerage_paise) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            [userId, symbol, "BUY", quantity, executionPricePaise, totalCostPaise, BROKERAGE_PAISE]
        );

        await client.query("COMMIT");

        logger.trade("TradingEngine", `BUY executed`, {
            userId,
            symbol,
            quantity,
            executionPrice,
            ltp: price,
            spread: "0.1%",
            brokerage: "₹20",
            totalCost: totalCostPaise / 100,
        });

        return {
            type: "BUY",
            symbol,
            quantity,
            ltpPaise: toPaise(price),
            executionPricePaise,
            brokeragePaise: BROKERAGE_PAISE,
            totalCostPaise,
        };
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
};

const executeSell = async (userId, symbol, quantity) => {
    if (!STOCK_MAP.has(symbol)) {
        throw new Error("Invalid stock symbol");
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error("Quantity must be a positive integer");
    }

    if (quantity > MAX_QUANTITY) {
        throw new Error("Maximum order quantity is " + MAX_QUANTITY);
    }

    const priceData = await redis.get(`stock:${symbol}`);
    const { price } = validatePriceData(priceData, symbol);

    const executionPrice = Math.round(price * SELL_SPREAD * 100) / 100;
    const executionPricePaise = toPaise(executionPrice);
    const grossValuePaise = executionPricePaise * quantity;
    const totalValuePaise = grossValuePaise - BROKERAGE_PAISE;

    if (totalValuePaise <= 0) {
        throw new Error("Trade value too small to cover brokerage");
    }

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const holding = await client.query(
            "SELECT quantity FROM portfolio WHERE user_id = $1 AND symbol = $2 FOR UPDATE",
            [userId, symbol]
        );

        if (holding.rows.length === 0 || holding.rows[0].quantity < quantity) {
            throw new Error("Insufficient holdings");
        }

        await client.query(
            "UPDATE users SET balance_paise = balance_paise + $1 WHERE id = $2",
            [totalValuePaise, userId]
        );

        const remainingQty = holding.rows[0].quantity - quantity;
        if (remainingQty === 0) {
            await client.query(
                "DELETE FROM portfolio WHERE user_id = $1 AND symbol = $2",
                [userId, symbol]
            );
        } else {
            await client.query(
                "UPDATE portfolio SET quantity = $1, updated_at = NOW() WHERE user_id = $2 AND symbol = $3",
                [remainingQty, userId, symbol]
            );
        }

        await client.query(
            "INSERT INTO orders (user_id, symbol, type, quantity, price_paise, total_value_paise, brokerage_paise) VALUES ($1, $2, $3, $4, $5, $6, $7)",
            [userId, symbol, "SELL", quantity, executionPricePaise, totalValuePaise, BROKERAGE_PAISE]
        );

        await client.query("COMMIT");

        logger.trade("TradingEngine", `SELL executed`, {
            userId,
            symbol,
            quantity,
            executionPrice,
            ltp: price,
            spread: "0.1%",
            brokerage: "₹20",
            netValue: totalValuePaise / 100,
        });

        return {
            type: "SELL",
            symbol,
            quantity,
            ltpPaise: toPaise(price),
            executionPricePaise,
            brokeragePaise: BROKERAGE_PAISE,
            totalValuePaise,
        };
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
};

export { executeBuy, executeSell };

/*
 * the actual trading logic. handles buy and sell with proper
 * postgres transactions so nothing gets half-done. adds 0.1%
 * spread on trades and a flat 20 rupee brokerage. validates
 * everything — stale prices, balance, holdings, max quantity.
 * the trade route is the only thing that calls this.
 */
