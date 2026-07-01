import { pool } from "../config/db.js";
import redis from "../config/redis.js";
import { toPaise } from "../utils/paise.js";
import { STOCK_MAP } from "../config/stocks.js";
import { isMarketOpen } from "../utils/marketHours.js";
import logger from "../utils/logger.js";

const BROKERAGE_PAISE = 2000;
const BUY_SPREAD = 1.001;
const SELL_SPREAD = 0.999;
const MAX_QUANTITY = 10000;
const MAX_PRICE_AGE_MS = 15000;
const MAX_DELIVERY_PRICE_AGE_MS = 30 * 60 * 1000;
const MAX_CLOSED_DELIVERY_AGE_MS = 8 * 60 * 60 * 1000;
const INTRADAY_LEVERAGE = 5;

const validatePriceData = (priceData, symbol, mode = "INTRADAY") => {
    if (!priceData) {
        throw new Error("Price not available for " + symbol);
    }

    const parsed = JSON.parse(priceData);
    if (!parsed.price || !parsed.timestamp) {
        throw new Error("Invalid price data for " + symbol);
    }

    const age = Date.now() - parsed.timestamp;
    if (isMarketOpen()) {
        const maxAge = mode === "INTRADAY" ? MAX_PRICE_AGE_MS : MAX_DELIVERY_PRICE_AGE_MS;
        if (age > maxAge) throw new Error("Price data is stale. Please try again.");
    } else if (mode === "DELIVERY" && age > MAX_CLOSED_DELIVERY_AGE_MS) {
        throw new Error("Price data is stale. Please try again.");
    }

    return parsed;
};

const executeBuy = async (userId, symbol, quantity, mode = "INTRADAY") => {
    if (!STOCK_MAP.has(symbol)) {
        throw new Error("Invalid stock symbol");
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error("Quantity must be a positive integer");
    }

    if (quantity > MAX_QUANTITY) {
        throw new Error("Maximum order quantity is " + MAX_QUANTITY);
    }

    if (mode !== "INTRADAY" && mode !== "DELIVERY") {
        throw new Error("Invalid order mode. Use INTRADAY or DELIVERY.");
    }

    const priceData = await redis.get(`stock:${symbol}`);
    const { price } = validatePriceData(priceData, symbol, mode);

    const executionPricePaise = Math.round(price * BUY_SPREAD * 100);
    const totalCostPaise = executionPricePaise * quantity + BROKERAGE_PAISE;

    const isIntraday = mode === "INTRADAY";
    const marginRequired = isIntraday
        ? Math.ceil(totalCostPaise / INTRADAY_LEVERAGE)
        : totalCostPaise;

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
        if (balancePaise < marginRequired) {
            throw new Error(
                isIntraday
                    ? `Insufficient margin. Need ${(marginRequired / 100).toFixed(2)} (5x leverage)`
                    : "Insufficient balance"
            );
        }

        await client.query(
            "UPDATE users SET balance_paise = balance_paise - $1 WHERE id = $2",
            [marginRequired, userId]
        );

        const existing = await client.query(
            "SELECT quantity, avg_price_paise, margin_used_paise FROM portfolio WHERE user_id = $1 AND symbol = $2 AND order_mode = $3 FOR UPDATE",
            [userId, symbol, mode]
        );

        if (existing.rows.length > 0) {
            const oldQty = existing.rows[0].quantity;
            const oldAvg = Number(existing.rows[0].avg_price_paise);
            const oldMargin = Number(existing.rows[0].margin_used_paise);
            const newAvg = Math.round(((oldQty * oldAvg) + (quantity * executionPricePaise)) / (oldQty + quantity));
            const newMargin = oldMargin + marginRequired;

            await client.query(
                "UPDATE portfolio SET quantity = quantity + $1, avg_price_paise = $2, margin_used_paise = $3, updated_at = NOW() WHERE user_id = $4 AND symbol = $5 AND order_mode = $6",
                [quantity, newAvg, newMargin, userId, symbol, mode]
            );
        } else {
            await client.query(
                "INSERT INTO portfolio (user_id, symbol, quantity, avg_price_paise, order_mode, margin_used_paise) VALUES ($1, $2, $3, $4, $5, $6)",
                [userId, symbol, quantity, executionPricePaise, mode, marginRequired]
            );
        }

        await client.query(
            "INSERT INTO orders (user_id, symbol, type, quantity, price_paise, total_value_paise, brokerage_paise, order_mode) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            [userId, symbol, "BUY", quantity, executionPricePaise, totalCostPaise, BROKERAGE_PAISE, mode]
        );

        await client.query("COMMIT");

        logger.trade("TradingEngine", `BUY executed`, {
            userId,
            symbol,
            quantity,
            mode,
            executionPrice: executionPricePaise / 100,
            ltp: price,
            spread: "0.1%",
            brokerage: "₹20",
            leverage: isIntraday ? "5x" : "1x",
            marginUsed: marginRequired / 100,
            totalCost: totalCostPaise / 100,
        });

        return {
            type: "BUY",
            symbol,
            quantity,
            mode,
            ltpPaise: toPaise(price),
            executionPricePaise,
            brokeragePaise: BROKERAGE_PAISE,
            totalCostPaise,
            marginRequiredPaise: marginRequired,
            leverage: isIntraday ? INTRADAY_LEVERAGE : 1,
        };
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
};

const executeSell = async (userId, symbol, quantity, mode = "INTRADAY") => {
    if (!STOCK_MAP.has(symbol)) {
        throw new Error("Invalid stock symbol");
    }

    if (!Number.isInteger(quantity) || quantity <= 0) {
        throw new Error("Quantity must be a positive integer");
    }

    if (quantity > MAX_QUANTITY) {
        throw new Error("Maximum order quantity is " + MAX_QUANTITY);
    }

    if (mode !== "INTRADAY" && mode !== "DELIVERY") {
        throw new Error("Invalid order mode. Use INTRADAY or DELIVERY.");
    }

    const priceData = await redis.get(`stock:${symbol}`);
    const { price } = validatePriceData(priceData, symbol, mode);

    const executionPricePaise = Math.round(price * SELL_SPREAD * 100);
    const grossValuePaise = executionPricePaise * quantity;
    const isIntraday = mode === "INTRADAY";

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const holding = await client.query(
            "SELECT quantity, avg_price_paise, margin_used_paise FROM portfolio WHERE user_id = $1 AND symbol = $2 AND order_mode = $3 FOR UPDATE",
            [userId, symbol, mode]
        );

        if (holding.rows.length === 0 || holding.rows[0].quantity < quantity) {
            throw new Error("Insufficient holdings");
        }

        const holdingQty = holding.rows[0].quantity;
        const avgPricePaise = Number(holding.rows[0].avg_price_paise);
        const totalMarginPaise = Number(holding.rows[0].margin_used_paise);

        let creditPaise;
        if (isIntraday) {
            const marginForSold = Math.round((quantity / holdingQty) * totalMarginPaise);
            const pnlPaise = (executionPricePaise - avgPricePaise) * quantity;
            creditPaise = marginForSold + pnlPaise - BROKERAGE_PAISE;
        } else {
            creditPaise = grossValuePaise - BROKERAGE_PAISE;
        }

        if (!isIntraday && creditPaise <= 0) {
            throw new Error("Trade value too small to cover brokerage");
        }

        const actualCredit = Math.max(0, creditPaise);

        await client.query(
            "UPDATE users SET balance_paise = balance_paise + $1 WHERE id = $2",
            [actualCredit, userId]
        );

        const remainingQty = holdingQty - quantity;
        if (remainingQty === 0) {
            await client.query(
                "DELETE FROM portfolio WHERE user_id = $1 AND symbol = $2 AND order_mode = $3",
                [userId, symbol, mode]
            );
        } else {
            const remainingMargin = Math.round(((holdingQty - quantity) / holdingQty) * totalMarginPaise);
            await client.query(
                "UPDATE portfolio SET quantity = $1, margin_used_paise = $2, updated_at = NOW() WHERE user_id = $3 AND symbol = $4 AND order_mode = $5",
                [remainingQty, remainingMargin, userId, symbol, mode]
            );
        }

        await client.query(
            "INSERT INTO orders (user_id, symbol, type, quantity, price_paise, total_value_paise, brokerage_paise, order_mode) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            [userId, symbol, "SELL", quantity, executionPricePaise, actualCredit, BROKERAGE_PAISE, mode]
        );

        await client.query("COMMIT");

        logger.trade("TradingEngine", `SELL executed`, {
            userId,
            symbol,
            quantity,
            mode,
            executionPrice: executionPricePaise / 100,
            ltp: price,
            spread: "0.1%",
            brokerage: "₹20",
            leverage: isIntraday ? "5x" : "1x",
            credited: actualCredit / 100,
        });

        return {
            type: "SELL",
            symbol,
            quantity,
            mode,
            ltpPaise: toPaise(price),
            executionPricePaise,
            brokeragePaise: BROKERAGE_PAISE,
            totalValuePaise: actualCredit,
            leverage: isIntraday ? INTRADAY_LEVERAGE : 1,
        };
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
};

export { executeBuy, executeSell, INTRADAY_LEVERAGE };

/*
 * the core trading engine with two modes: intraday (MIS) and
 * delivery (CNC). intraday gives 5x leverage so users only need
 * to put up 20% margin — the rest is "borrowed". delivery deducts
 * the full amount. on sell, intraday credits back the margin plus
 * realized pnl whereas delivery credits the full sale value.
 * both modes use the same 0.1% spread and flat 20 rupee brokerage.
 * everything runs inside postgres transactions with FOR UPDATE
 * row locks so concurrent trades cant corrupt balances.
 */
