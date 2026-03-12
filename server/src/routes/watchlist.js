import { Router } from "express";
import auth from "../middleware/auth.js";
import { pool } from "../config/db.js";
import redis from "../config/redis.js";
import { STOCK_MAP } from "../config/stocks.js";

const router = Router();

router.get("/", auth, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT symbol, created_at FROM watchlist WHERE user_id = $1 ORDER BY created_at DESC",
            [req.userId]
        );

        const pipeline = redis.pipeline();
        result.rows.forEach((w) => pipeline.get(`stock:${w.symbol}`));
        const priceResults = await pipeline.exec();

        const watchlist = result.rows.map((w, i) => {
            const priceData = priceResults[i][1] ? JSON.parse(priceResults[i][1]) : null;
            return {
                symbol: w.symbol,
                name: STOCK_MAP.get(w.symbol)?.name || w.symbol,
                price: priceData?.price ?? null,
                change: priceData?.change ?? null,
                changePercent: priceData?.changePercent ?? null,
                addedAt: w.created_at,
            };
        });

        res.json(watchlist);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch watchlist" });
    }
});

router.post("/add", auth, async (req, res) => {
    try {
        const { symbol } = req.body;
        if (!symbol) {
            return res.status(400).json({ error: "Symbol is required" });
        }

        const upperSymbol = symbol.toUpperCase();
        if (!STOCK_MAP.has(upperSymbol)) {
            return res.status(400).json({ error: "Invalid stock symbol" });
        }

        await pool.query(
            "INSERT INTO watchlist (user_id, symbol) VALUES ($1, $2) ON CONFLICT (user_id, symbol) DO NOTHING",
            [req.userId, upperSymbol]
        );

        res.json({ symbol: upperSymbol, added: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to add to watchlist" });
    }
});

router.delete("/remove", auth, async (req, res) => {
    try {
        const { symbol } = req.body;
        if (!symbol) {
            return res.status(400).json({ error: "Symbol is required" });
        }

        await pool.query(
            "DELETE FROM watchlist WHERE user_id = $1 AND symbol = $2",
            [req.userId, symbol.toUpperCase()]
        );

        res.json({ symbol: symbol.toUpperCase(), removed: true });
    } catch (err) {
        res.status(500).json({ error: "Failed to remove from watchlist" });
    }
});

export default router;
