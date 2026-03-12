import { Router } from "express";
import redis from "../config/redis.js";
import logger from "../utils/logger.js";

const router = Router();

const RANGE_CONFIG = {
    "1d": { interval: "1m", period: "1d", cacheTTL: 300 },
    "5d": { interval: "5m", period: "5d", cacheTTL: 600 },
    "1mo": { interval: "1h", period: "1mo", cacheTTL: 600 },
    "3mo": { interval: "1d", period: "3mo", cacheTTL: 600 },
    "1y": { interval: "1d", period: "1y", cacheTTL: 600 },
    "5y": { interval: "1wk", period: "5y", cacheTTL: 600 },
};

router.get("/:symbol", async (req, res) => {
    try {
        const { symbol } = req.params;
        const range = req.query.range || "1d";
        const config = RANGE_CONFIG[range];

        if (!config) {
            return res.status(400).json({ error: "Invalid range. Supported: 1d, 5d, 1mo, 3mo, 1y, 5y" });
        }

        const cacheKey = `chart:${symbol.toUpperCase()}:${range}`;
        const cached = await redis.get(cacheKey);

        if (cached) {
            return res.json(JSON.parse(cached));
        }

        const yahooSymbol = `${symbol.toUpperCase()}.NS`;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${config.interval}&range=${config.period}`;

        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            },
        });

        if (!response.ok) {
            return res.status(502).json({ error: "Failed to fetch chart data from provider" });
        }

        const data = await response.json();
        const result = data.chart?.result?.[0];

        if (!result || !result.timestamp) {
            return res.json([]);
        }

        const timestamps = result.timestamp;
        const ohlcv = result.indicators.quote[0];

        const candles = timestamps
            .map((t, i) => ({
                time: t,
                open: ohlcv.open[i],
                high: ohlcv.high[i],
                low: ohlcv.low[i],
                close: ohlcv.close[i],
                volume: ohlcv.volume[i],
            }))
            .filter((c) => c.open != null && c.close != null);

        await redis.setex(cacheKey, config.cacheTTL, JSON.stringify(candles));

        logger.info("ChartService", `Fetched ${candles.length} candles for ${symbol} (${range})`);
        res.json(candles);
    } catch (err) {
        logger.error("ChartService", "Chart fetch failed", { error: err.message });
        res.status(500).json({ error: "Failed to fetch chart data" });
    }
});

export default router;
