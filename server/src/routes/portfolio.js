import { Router } from "express";
import auth from "../middleware/auth.js";
import { pool } from "../config/db.js";
import redis from "../config/redis.js";
import { toPaise } from "../utils/paise.js";
import logger from "../utils/logger.js";

const router = Router();

router.get("/", auth, async (req, res) => {
    try {
        const holdingsResult = await pool.query(
            "SELECT symbol, quantity, avg_price_paise, order_mode, margin_used_paise FROM portfolio WHERE user_id = $1",
            [req.userId]
        );

        const userResult = await pool.query(
            "SELECT balance_paise FROM users WHERE id = $1",
            [req.userId]
        );

        // L3: stale cookie after account deletion returns 401, not 500
        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: "Unauthorized" });
        }

        const balancePaise = Number(userResult.rows[0].balance_paise);

        const pipeline = redis.pipeline();
        holdingsResult.rows.forEach((h) => pipeline.get(`stock:${h.symbol}`));
        const priceResults = await pipeline.exec();

        let totalInvestedPaise = 0;
        let totalCurrentPaise = 0;
        const intradayHoldings = [];
        const deliveryHoldings = [];

        holdingsResult.rows.forEach((h, i) => {
            const priceData = priceResults[i][1] ? JSON.parse(priceResults[i][1]) : null;
            const livePrice = typeof priceData?.price === "number" ? priceData.price : null;
            const currentPricePaise = livePrice != null ? toPaise(livePrice) : Number(h.avg_price_paise);
            const avgPricePaise = Number(h.avg_price_paise);
            const marginUsedPaise = Number(h.margin_used_paise);
            const investedPaise = avgPricePaise * h.quantity;
            const currentValuePaise = currentPricePaise * h.quantity;
            const pnlPaise = currentValuePaise - investedPaise;

            totalInvestedPaise += investedPaise;
            totalCurrentPaise += currentValuePaise;

            // L4: intraday PnL% shown on margin (return on capital), not notional.
            // A 2% move on 5x leverage is ~10% return on the margin posted — that's
            // the number a leveraged trader actually cares about.
            const pnlPct = h.order_mode === "INTRADAY" && marginUsedPaise > 0
                ? (pnlPaise / marginUsedPaise) * 100
                : investedPaise > 0 ? (pnlPaise / investedPaise) * 100 : 0;

            const holding = {
                symbol: h.symbol,
                quantity: h.quantity,
                avgPricePaise,
                currentPricePaise,
                investedPaise,
                currentValuePaise,
                pnlPaise,
                pnlPct: Math.round(pnlPct * 100) / 100,
                orderMode: h.order_mode,
                marginUsedPaise,
            };

            if (h.order_mode === "INTRADAY") {
                intradayHoldings.push(holding);
            } else {
                deliveryHoldings.push(holding);
            }
        });

        res.json({
            balancePaise,
            intradayHoldings,
            deliveryHoldings,
            totalInvestedPaise,
            totalCurrentPaise,
            totalPnlPaise: totalCurrentPaise - totalInvestedPaise,
        });
    } catch (err) {
        logger.error("Portfolio", "Failed to fetch portfolio", { error: err.message });
        res.status(500).json({ error: "Failed to fetch portfolio" });
    }
});

export default router;
