import cron from "node-cron";
import { pool } from "../config/db.js";
import redis from "../config/redis.js";
import { toPaise } from "../utils/paise.js";
import logger from "../utils/logger.js";

const squareOffAll = async () => {
    logger.info("SquareOff", "Starting auto square-off");

    try {
        const holdings = await pool.query(
            "SELECT id, user_id, symbol, quantity FROM portfolio WHERE quantity > 0"
        );

        if (holdings.rows.length === 0) {
            logger.info("SquareOff", "No open positions to square off");
            return;
        }

        let succeeded = 0;
        let failed = 0;

        for (const holding of holdings.rows) {
            const priceData = await redis.get(`stock:${holding.symbol}`);
            if (!priceData) {
                logger.warn("SquareOff", `No price for ${holding.symbol}, skipping`);
                failed++;
                continue;
            }

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
                    "INSERT INTO orders (user_id, symbol, type, quantity, price_paise, total_value_paise, brokerage_paise) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                    [holding.user_id, holding.symbol, "SELL", holding.quantity, pricePaise, totalValuePaise, 0]
                );

                await client.query("COMMIT");
                succeeded++;

                logger.trade("SquareOff", `Squared off ${holding.symbol}`, {
                    userId: holding.user_id,
                    quantity: holding.quantity,
                    price,
                    value: totalValuePaise / 100,
                });
            } catch (err) {
                await client.query("ROLLBACK");
                failed++;
                logger.error("SquareOff", `Failed for user ${holding.user_id}`, { error: err.message });
            } finally {
                client.release();
            }
        }

        logger.info("SquareOff", `Complete: ${succeeded} succeeded, ${failed} failed`);
    } catch (err) {
        logger.error("SquareOff", "Job error", { error: err.message });
    }
};

const startSquareOffJob = () => {
    cron.schedule("25 15 * * 1-5", squareOffAll, {
        timezone: "Asia/Kolkata",
    });
    logger.info("SquareOff", "Scheduled at 15:25 IST Mon-Fri");
};

export { startSquareOffJob, squareOffAll };
