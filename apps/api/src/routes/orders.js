import { Router } from "express";
import auth from "../middleware/auth.js";
import { pool } from "../config/db.js";
import logger from "../utils/logger.js";

const router = Router();

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

router.get("/", auth, async (req, res) => {
    try {
        const limit = Math.min(MAX_LIMIT, Math.max(1, Number(req.query.limit) || DEFAULT_LIMIT));
        // Non-integer / out-of-range cursors (e.g. ?before=1e999) would error inside pg
        const rawBefore = Number(req.query.before);
        const before = Number.isSafeInteger(rawBefore) && rawBefore > 0 ? rawBefore : null;

        const result = before
            ? await pool.query(
                "SELECT id, symbol, type, quantity, price_paise, total_value_paise, brokerage_paise, pnl_paise, order_mode, decision_id, created_at FROM orders WHERE user_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3",
                [req.userId, before, limit + 1]
            )
            : await pool.query(
                "SELECT id, symbol, type, quantity, price_paise, total_value_paise, brokerage_paise, pnl_paise, order_mode, decision_id, created_at FROM orders WHERE user_id = $1 ORDER BY id DESC LIMIT $2",
                [req.userId, limit + 1]
            );

        const hasMore = result.rows.length > limit;
        const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

        const orders = rows.map((o) => ({
            id: o.id,
            symbol: o.symbol,
            type: o.type,
            quantity: o.quantity,
            pricePaise: Number(o.price_paise),
            totalValuePaise: Number(o.total_value_paise),
            brokeragePaise: Number(o.brokerage_paise),
            pnlPaise: o.pnl_paise != null ? Number(o.pnl_paise) : null,
            orderMode: o.order_mode,
            decisionId: o.decision_id,
            createdAt: o.created_at,
        }));

        res.json({ orders, hasMore });
    } catch (err) {
        logger.error("Orders", "Failed to fetch orders", { error: err.message });
        res.status(500).json({ error: "Failed to fetch orders" });
    }
});

export default router;

/*
 * order history route now includes orderMode in each record so
 * the frontend can show whether each trade was intraday (MIS)
 * or delivery (CNC). still pulls the last 100 orders sorted
 * newest first. mounted at /api/orders, needs auth.
 */
