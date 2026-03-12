import { Router } from "express";
import redis from "../config/redis.js";
import { INDICES } from "../services/marketWorker.js";

const router = Router();

router.get("/", async (req, res) => {
    try {
        const pipeline = redis.pipeline();
        INDICES.forEach((index) => pipeline.get(`index:${index.symbol}`));
        const results = await pipeline.exec();

        const indices = INDICES.map((index, i) => {
            const data = results[i][1] ? JSON.parse(results[i][1]) : null;
            return {
                symbol: index.symbol,
                name: index.name,
                price: data?.price ?? null,
                change: data?.change ?? null,
                changePercent: data?.changePercent ?? null,
                timestamp: data?.timestamp ?? null,
            };
        });

        res.json(indices);
    } catch (err) {
        res.status(500).json({ error: "Failed to fetch indices" });
    }
});

export default router;
