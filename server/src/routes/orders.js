import { Router } from "express";
import auth from "../middleware/auth.js";
import { pool } from "../config/db.js";

const router = Router();

router.get("/", auth, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT id, symbol, type, quantity, price_paise, total_value_paise, order_mode, created_at FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
            [req.userId]
        );

        const orders = result.rows.map((o) => ({
            id: o.id,
            symbol: o.symbol,
            type: o.type,
            quantity: o.quantity,
            pricePaise: Number(o.price_paise),
            totalValuePaise: Number(o.total_value_paise),
            orderMode: o.order_mode,
            createdAt: o.created_at,
        }));

        res.json(orders);
    } catch (err) {
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
