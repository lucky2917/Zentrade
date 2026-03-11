import { pool } from "../config/db.js";
import redis from "../config/redis.js";
import { toPaise } from "../utils/paise.js";
import { STOCK_MAP } from "../config/stocks.js";

const executeBuy = async (userId, symbol, quantity) => {
    if (!STOCK_MAP.has(symbol)) {
        throw new Error("Invalid stock symbol");
    }

    if (quantity <= 0 || !Number.isInteger(quantity)) {
        throw new Error("Quantity must be a positive integer");
    }

    const priceData = await redis.get(`stock:${symbol}`);
    if (!priceData) {
        throw new Error("Price not available");
    }

    const { price } = JSON.parse(priceData);
    const pricePaise = toPaise(price);
    const totalCostPaise = pricePaise * quantity;

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
            const newAvg = Math.round(((oldQty * oldAvg) + (quantity * pricePaise)) / (oldQty + quantity));

            await client.query(
                "UPDATE portfolio SET quantity = quantity + $1, avg_price_paise = $2, updated_at = NOW() WHERE user_id = $3 AND symbol = $4",
                [quantity, newAvg, userId, symbol]
            );
        } else {
            await client.query(
                "INSERT INTO portfolio (user_id, symbol, quantity, avg_price_paise) VALUES ($1, $2, $3, $4)",
                [userId, symbol, quantity, pricePaise]
            );
        }

        await client.query(
            "INSERT INTO orders (user_id, symbol, type, quantity, price_paise, total_value_paise) VALUES ($1, $2, $3, $4, $5, $6)",
            [userId, symbol, "BUY", quantity, pricePaise, totalCostPaise]
        );

        await client.query("COMMIT");

        return {
            type: "BUY",
            symbol,
            quantity,
            pricePaise,
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

    if (quantity <= 0 || !Number.isInteger(quantity)) {
        throw new Error("Quantity must be a positive integer");
    }

    const priceData = await redis.get(`stock:${symbol}`);
    if (!priceData) {
        throw new Error("Price not available");
    }

    const { price } = JSON.parse(priceData);
    const pricePaise = toPaise(price);
    const totalValuePaise = pricePaise * quantity;

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
            "INSERT INTO orders (user_id, symbol, type, quantity, price_paise, total_value_paise) VALUES ($1, $2, $3, $4, $5, $6)",
            [userId, symbol, "SELL", quantity, pricePaise, totalValuePaise]
        );

        await client.query("COMMIT");

        return {
            type: "SELL",
            symbol,
            quantity,
            pricePaise,
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
