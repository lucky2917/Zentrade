import { Router } from "express";
import { pool } from "../config/db.js";
import logger from "../utils/logger.js";

const router = Router();

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

router.get("/", async (req, res) => {
    try {
        const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
        const rawOffset = Number(req.query.offset);
        const offset = Number.isSafeInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
        const query = String(req.query.query ?? "").trim().slice(0, 64);

        const params = [];
        let where = "";
        if (query) {
            params.push(`%${query.replace(/[%_\\]/g, "\\$&")}%`);
            where = "WHERE symbol ILIKE $1 OR name ILIKE $1";
        }
        params.push(limit + 1, offset);

        const { rows } = await pool.query(
            `SELECT id, venue, symbol, name, asset_class, currency
             FROM instruments ${where}
             ORDER BY symbol, venue
             LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params
        );

        const hasMore = rows.length > limit;
        const instruments = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
            instrumentId: r.id,
            venue: r.venue,
            symbol: r.symbol,
            name: r.name,
            assetClass: r.asset_class,
            currency: r.currency,
        }));

        res.json({ instruments, hasMore, offset });
    } catch (err) {
        logger.error("Instruments", "search failed", { error: err.message });
        res.status(500).json({ error: "Failed to fetch instruments" });
    }
});

export default router;
