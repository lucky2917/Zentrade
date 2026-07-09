import { Router } from "express";
import auth from "../middleware/auth.js";
import redis from "../config/redis.js";
import { STOCK_MAP } from "../config/stocks.js";
import { analyseStock } from "../services/aiEngine.js";
import logger from "../utils/logger.js";

const router = Router();

// M5: each user gets 10 AI analyses per minute to cap Groq spend.
// Cache misses fire 4 LLM calls each; 10/min per user = ~40 Groq calls/min max per user.
const AI_USER_LIMIT = 10;
const AI_WINDOW_SECS = 60;

router.get("/analyse/:symbol", auth, async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();

    if (!STOCK_MAP.has(symbol)) {
        return res.status(400).json({ error: `${symbol} is not available on Zentrade.` });
    }

    // Per-user rate check via Redis counter
    try {
        const key = `ai:rl:${req.userId}`;
        const count = await redis.incr(key);
        if (count === 1) await redis.expire(key, AI_WINDOW_SECS);
        if (count > AI_USER_LIMIT) {
            return res.status(429).json({ error: "Too many analysis requests. Try again in a minute." });
        }
    } catch (err) {
        // If Redis is down, fail open so a cache hiccup doesn't kill AI for everyone
        logger.error("AI", "Rate limit Redis check failed, allowing through", { error: err.message });
    }

    try {
        const result = await analyseStock(symbol);
        res.json(result);
    } catch {
        res.status(500).json({ error: "Analysis unavailable" });
    }
});

export default router;
