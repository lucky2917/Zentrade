import { Router } from "express";
import auth from "../middleware/auth.js";
import redis from "../config/redis.js";
import logger from "../utils/logger.js";
import { STOCK_MAP } from "../config/stocks.js";
import { getCandlesForRange } from "../services/fyers/fyersREST.js";
import { toFyersStockSymbol } from "../services/fyers/smartWall.js";

const router = Router();

const CACHE_TTL = {
    "1d": 300,
    "5d": 600,
    "1mo": 600,
    "3mo": 600,
    "1y": 600,
    "5y": 600,
};

router.get("/:symbol", auth, async (req, res) => {
    try {
        const sym = req.params.symbol.toUpperCase();
        const range = req.query.range || "1d";

        if (!STOCK_MAP.has(sym)) {
            return res.status(400).json({ error: "Unknown symbol" });
        }

        if (!CACHE_TTL[range]) {
            return res.status(400).json({ error: "Invalid range. Supported: 1d, 5d, 1mo, 3mo, 1y, 5y" });
        }

        const cacheKey = `chart:${sym}:${range}`;
        const cached = await redis.get(cacheKey);

        if (cached) {
            return res.json(JSON.parse(cached));
        }

        const fyersSymbol = toFyersStockSymbol(sym);
        const candles = await getCandlesForRange(fyersSymbol, range);

        if (candles?.length > 0) {
            await redis.setex(cacheKey, CACHE_TTL[range], JSON.stringify(candles));
        }

        logger.info("ChartService", `Fetched ${candles.length} candles for ${sym} (${range})`);
        res.json(candles);
    } catch (err) {
        logger.error("ChartService", "Chart fetch failed", { error: err.message });
        res.status(500).json({ error: "Failed to fetch chart data" });
    }
});

export default router;
