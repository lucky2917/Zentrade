import { Router } from "express";
import auth from "../middleware/auth.js";
import { pool } from "../config/db.js";
import redis from "../config/redis.js";

const router = Router();

router.get("/", auth, async (req, res) => {
    try {
        const holdingsResult = await pool.query(
            "SELECT symbol, quantity, avg_price_paise FROM portfolio WHERE user_id = $1",
            [req.userId]
        );

        const userResult = await pool.query(
            "SELECT balance_paise FROM users WHERE id = $1",
            [req.userId]
        );

        const balancePaise = Number(userResult.rows[0].balance_paise);

        const pipeline = redis.pipeline();
        holdingsResult.rows.forEach((h) => pipeline.get(`stock:${h.symbol}`));
        const priceResults = await pipeline.exec();

        let totalInvestedPaise = 0;
        let totalCurrentPaise = 0;

        const holdings = holdingsResult.rows.map((h, i) => {
            const priceData = priceResults[i][1] ? JSON.parse(priceResults[i][1]) : null;
            const currentPrice = priceData ? priceData.price : 0;
            const currentPricePaise = Math.round(currentPrice * 100);
            const avgPricePaise = Number(h.avg_price_paise);
            const investedPaise = avgPricePaise * h.quantity;
            const currentValuePaise = currentPricePaise * h.quantity;
            const pnlPaise = currentValuePaise - investedPaise;

            totalInvestedPaise += investedPaise;
            totalCurrentPaise += currentValuePaise;

            return {
                symbol: h.symbol,
                quantity: h.quantity,
                avgPricePaise,
                currentPricePaise,
                investedPaise,
                currentValuePaise,
                pnlPaise,
            };
        });

        res.json({
            balancePaise,
            holdings,
            totalInvestedPaise,
            totalCurrentPaise,
            totalPnlPaise: totalCurrentPaise - totalInvestedPaise,
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch portfolio" });
    }
});

export default router;
