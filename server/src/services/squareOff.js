import cron from "node-cron";
import { pool } from "../config/db.js";
import redis from "../config/redis.js";
import { toPaise } from "../utils/paise.js";
import logger from "../utils/logger.js";

const squareOffAll = async () => {
    logger.info("SquareOff", "Starting auto square-off for INTRADAY positions");

    try {
        const holdings = await pool.query(
            "SELECT id, user_id, symbol, quantity, avg_price_paise, margin_used_paise FROM portfolio WHERE quantity > 0 AND order_mode = 'INTRADAY'"
        );

        if (holdings.rows.length === 0) {
            logger.info("SquareOff", "No intraday positions to square off");
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
            const executionPricePaise = toPaise(price);
            const avgPricePaise = Number(holding.avg_price_paise);
            const marginUsedPaise = Number(holding.margin_used_paise);
            const pnlPaise = (executionPricePaise - avgPricePaise) * holding.quantity;
            const creditPaise = marginUsedPaise + pnlPaise;

            const client = await pool.connect();
            try {
                await client.query("BEGIN");

                if (creditPaise > 0) {
                    await client.query(
                        "UPDATE users SET balance_paise = balance_paise + $1 WHERE id = $2",
                        [creditPaise, holding.user_id]
                    );
                } else {
                    await client.query(
                        "UPDATE users SET balance_paise = GREATEST(0, balance_paise + $1) WHERE id = $2",
                        [creditPaise, holding.user_id]
                    );
                }

                await client.query(
                    "DELETE FROM portfolio WHERE id = $1",
                    [holding.id]
                );

                await client.query(
                    "INSERT INTO orders (user_id, symbol, type, quantity, price_paise, total_value_paise, brokerage_paise, order_mode) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                    [holding.user_id, holding.symbol, "SELL", holding.quantity, executionPricePaise, creditPaise, 0, "INTRADAY"]
                );

                await client.query("COMMIT");
                succeeded++;

                logger.trade("SquareOff", `Squared off ${holding.symbol}`, {
                    userId: holding.user_id,
                    quantity: holding.quantity,
                    price,
                    avgPrice: avgPricePaise / 100,
                    pnl: pnlPaise / 100,
                    marginReturned: marginUsedPaise / 100,
                    credited: creditPaise / 100,
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
    logger.info("SquareOff", "Scheduled at 15:25 IST Mon-Fri (INTRADAY only)");
};

export { startSquareOffJob, squareOffAll };

/*
 * end of day auto square-off that ONLY targets intraday positions.
 * delivery holdings are completely untouched — they sit in the
 * portfolio until the user manually sells. for intraday, it
 * calculates the pnl against the avg buy price and credits back
 * the original margin plus whatever profit or loss was made.
 * if a leveraged position lost more than the margin, balance
 * floors at zero. runs at 15:25 IST mon-fri via node-cron.
 */
