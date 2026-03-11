import { Router } from "express";
import redis from "../config/redis.js";
import { STOCKS } from "../config/stocks.js";

const router = Router();

router.get("/", async (req, res) => {
    try {
        const pipeline = redis.pipeline();
        STOCKS.forEach((stock) => pipeline.get(`stock:${stock.symbol}`));
        const results = await pipeline.exec();

        const stocks = STOCKS.map((stock, i) => {
            const data = results[i][1] ? JSON.parse(results[i][1]) : null;
            return {
                symbol: stock.symbol,
                name: stock.name,
                price: data ? data.price : null,
                change: data ? data.change : null,
                timestamp: data ? data.timestamp : null,
            };
        });

        res.json(stocks);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch stocks" });
    }
});

router.get("/:symbol", async (req, res) => {
    try {
        const { symbol } = req.params;
        const data = await redis.get(`stock:${symbol.toUpperCase()}`);

        if (!data) {
            return res.status(404).json({ error: "Stock not found" });
        }

        const parsed = JSON.parse(data);
        const stockInfo = STOCKS.find((s) => s.symbol === symbol.toUpperCase());

        res.json({
            symbol: symbol.toUpperCase(),
            name: stockInfo ? stockInfo.name : symbol,
            price: parsed.price,
            change: parsed.change,
            timestamp: parsed.timestamp,
        });
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch stock" });
    }
});

export default router;
