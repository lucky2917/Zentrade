import cron from "node-cron";
import { pool } from "../config/db.js";
import redis from "../config/redis.js";
import { toPaise } from "../utils/paise.js";

const squareOffAll = async () => {
    try {
        const holdings = await pool.query(
            "SELECT id, user_id, symbol, quantity FROM portfolio"
        );

        for (const holding of holdings.rows) {
            const priceData = await redis.get(`stock:${holding.symbol}`);
            if (!priceData) continue;

            const { price } = JSON.parse(priceData);
            const pricePaise = toPaise(price);
            const totalValuePaise = pricePaise * holding.quantity;

            const client = await pool.connect();
            try {
                await client.query("BEGIN");

                await client.query(
                    "UPDATE users SET balance_paise = balance_paise + $1 WHERE id = $2",
                    [totalValuePaise, holding.user_id]
                );

                await client.query(
                    "DELETE FROM portfolio WHERE id = $1",
                    [holding.id]
                );

                await client.query(
                    "INSERT INTO orders (user_id, symbol, type, quantity, price_paise, total_value_paise) VALUES ($1, $2, $3, $4, $5, $6)",
                    [holding.user_id, holding.symbol, "SELL", holding.quantity, pricePaise, totalValuePaise]
                );

                await client.query("COMMIT");
            } catch (err) {
                await client.query("ROLLBACK");
                console.error(`Square-off failed for user ${holding.user_id}:`, err.message);
            } finally {
                client.release();
            }
        }
    } catch (err) {
        console.error("Square-off job error:", err.message);
    }
};

const startSquareOffJob = () => {
    cron.schedule("25 15 * * 1-5", squareOffAll, {
        timezone: "Asia/Kolkata",
    });
};

export { startSquareOffJob, squareOffAll };
