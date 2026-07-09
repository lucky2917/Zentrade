import cron from "node-cron";
import { pool } from "../config/db.js";
import redis from "../config/redis.js";
import { toPaise } from "../utils/paise.js";
import logger from "../utils/logger.js";

const BROKERAGE_PAISE = 2000;
const SELL_SPREAD = 0.999;
// Allow prices up to 45 min old at square-off time (market data can lag at EOD)
const MAX_SQUAREOFF_PRICE_AGE_MS = 45 * 60 * 1000;
// Process holdings concurrently in batches of 5
const CONCURRENCY = 5;

let cronTask = null;

const processHolding = async (holding, priceData) => {
    if (!priceData) {
        logger.warn("SquareOff", `No price for ${holding.symbol}, skipping`);
        return { status: "skipped", reason: "no_price" };
    }

    const parsed = JSON.parse(priceData);
    const age = Date.now() - (parsed.timestamp || 0);
    if (age > MAX_SQUAREOFF_PRICE_AGE_MS) {
        logger.warn("SquareOff", `Stale price for ${holding.symbol} (${Math.round(age / 60000)}min old), skipping`);
        return { status: "skipped", reason: "stale_price" };
    }

    // C4 fix: apply sell spread (same as manual sell) — no free lunch at EOD
    const executionPricePaise = Math.round(parsed.price * SELL_SPREAD * 100);

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const locked = await client.query(
            "SELECT id, user_id, symbol, quantity, avg_price_paise, margin_used_paise FROM portfolio WHERE id = $1 AND quantity > 0 FOR UPDATE SKIP LOCKED",
            [holding.id]
        );

        if (locked.rows.length === 0) {
            await client.query("ROLLBACK");
            return { status: "skipped", reason: "already_closed" };
        }

        const fresh = locked.rows[0];
        const avgPricePaise = Number(fresh.avg_price_paise);
        const marginUsedPaise = Number(fresh.margin_used_paise);
        const pnlPaise = (executionPricePaise - avgPricePaise) * fresh.quantity;
        const creditPaise = marginUsedPaise + pnlPaise - BROKERAGE_PAISE;
        const grossProceedsPaise = executionPricePaise * fresh.quantity;

        // H1 fix: allow negative credit — real losses reduce real balance.
        // Balance can go negative; new buys are already blocked when balance < marginRequired.
        await client.query(
            "UPDATE users SET balance_paise = balance_paise + $1 WHERE id = $2",
            [creditPaise, fresh.user_id]
        );

        await client.query(
            "DELETE FROM portfolio WHERE id = $1",
            [fresh.id]
        );

        // H3 fix: total_value_paise = gross proceeds; pnl_paise = realized PnL
        await client.query(
            "INSERT INTO orders (user_id, symbol, type, quantity, price_paise, total_value_paise, brokerage_paise, order_mode, pnl_paise) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
            [fresh.user_id, fresh.symbol, "SELL", fresh.quantity, executionPricePaise, grossProceedsPaise, BROKERAGE_PAISE, "INTRADAY", pnlPaise]
        );

        await client.query("COMMIT");

        logger.trade("SquareOff", `Squared off ${fresh.symbol}`, {
            userId: fresh.user_id,
            quantity: fresh.quantity,
            price: parsed.price,
            avgPrice: avgPricePaise / 100,
            pnl: pnlPaise / 100,
            marginReturned: marginUsedPaise / 100,
            credited: creditPaise / 100,
        });

        return { status: "ok" };
    } catch (err) {
        await client.query("ROLLBACK");
        logger.error("SquareOff", `Failed for user ${holding.user_id} symbol ${holding.symbol}`, { error: err.message });
        return { status: "failed", error: err.message };
    } finally {
        client.release();
    }
};

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

        // M9 fix: batch all Redis price reads in one pipeline round-trip
        const uniqueSymbols = [...new Set(holdings.rows.map((h) => h.symbol))];
        const pipeline = redis.pipeline();
        uniqueSymbols.forEach((sym) => pipeline.get(`stock:${sym}`));
        const priceResults = await pipeline.exec();
        const priceMap = new Map(uniqueSymbols.map((sym, i) => [sym, priceResults[i][1]]));

        let succeeded = 0;
        let failed = 0;

        // M9 fix: process CONCURRENCY holdings at a time instead of serially
        for (let i = 0; i < holdings.rows.length; i += CONCURRENCY) {
            const chunk = holdings.rows.slice(i, i + CONCURRENCY);
            const results = await Promise.all(
                chunk.map((h) => processHolding(h, priceMap.get(h.symbol)))
            );
            for (const r of results) {
                if (r.status === "ok") succeeded++;
                else if (r.status === "failed") failed++;
            }
        }

        logger.info("SquareOff", `Complete: ${succeeded} succeeded, ${failed} failed`);
    } catch (err) {
        logger.error("SquareOff", "Job error", { error: err.message });
    }
};

// C3: run on startup to catch positions missed while the server was sleeping
const reconcileSquareOff = async () => {
    try {
        const now = new Date();
        const istOffset = 5.5 * 60 * 60 * 1000;
        const ist = new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);
        const day = ist.getDay();
        if (day === 0 || day === 6) return; // weekend

        const timeInMinutes = ist.getHours() * 60 + ist.getMinutes();
        if (timeInMinutes < 15 * 60 + 25) return; // before square-off window

        const { rows } = await pool.query(
            "SELECT COUNT(*) AS cnt FROM portfolio WHERE order_mode = 'INTRADAY' AND quantity > 0"
        );
        const open = Number(rows[0].cnt);
        if (open > 0) {
            logger.info("SquareOff", `Startup: found ${open} open intraday positions past 15:25 IST — reconciling`);
            await squareOffAll();
        }
    } catch (err) {
        logger.error("SquareOff", "Reconcile error", { error: err.message });
    }
};

const startSquareOffJob = () => {
    cronTask = cron.schedule("25 15 * * 1-5", squareOffAll, {
        timezone: "Asia/Kolkata",
    });
    logger.info("SquareOff", "Scheduled at 15:25 IST Mon-Fri (INTRADAY only)");
};

const stopSquareOffJob = () => {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
    }
};

export { startSquareOffJob, stopSquareOffJob, squareOffAll, reconcileSquareOff };
