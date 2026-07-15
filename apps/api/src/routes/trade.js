import { Router } from "express";
import auth from "../middleware/auth.js";
import { validate, required, positiveInt } from "../middleware/validate.js";
import { executeBuy, executeSell } from "../services/tradingEngine.js";
import { isMarketOpen } from "../utils/marketHours.js";
import { pool } from "../config/db.js";

const router = Router();

const VALID_MODES = ["INTRADAY", "DELIVERY"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tradeValidation = validate({ symbol: [required], quantity: [required, positiveInt] });

/**
 * M9: optional decision linkage. When a decisionId is supplied it must exist
 * and belong to the instrument being traded — a trade may not claim the
 * authority of an unrelated analysis.
 * Returns { ok: true, decisionId } or { ok: false, error }.
 */
const resolveDecisionLink = async (rawDecisionId, symbol) => {
    if (rawDecisionId === undefined || rawDecisionId === null) return { ok: true, decisionId: null };
    if (typeof rawDecisionId !== "string" || !UUID_PATTERN.test(rawDecisionId)) {
        return { ok: false, error: "decisionId must be a UUID" };
    }
    const { rows } = await pool.query(
        `SELECT 1 FROM decisions d JOIN instruments i ON i.id = d.instrument_id
         WHERE d.id = $1 AND i.venue = 'NSE' AND i.symbol = $2`,
        [rawDecisionId, symbol]
    );
    if (rows.length === 0) {
        return { ok: false, error: "decisionId does not reference a decision for this instrument" };
    }
    return { ok: true, decisionId: rawDecisionId };
};

// Known user-facing error prefixes from tradingEngine — safe to forward as-is
const USER_ERRORS = [
    "Insufficient", "Invalid stock symbol", "Quantity must be",
    "Maximum order quantity", "Invalid order mode", "Price data is stale",
    "Price not available", "Trade value too small", "User not found",
];
const isUserError = (msg) => USER_ERRORS.some((p) => msg.startsWith(p));

router.post("/buy", auth, tradeValidation, async (req, res) => {
    try {
        const { symbol, quantity, mode } = req.body;

        const orderMode = (mode || "INTRADAY").toUpperCase();
        if (!VALID_MODES.includes(orderMode)) {
            return res.status(400).json({ error: "Invalid mode. Use INTRADAY or DELIVERY." });
        }

        if (orderMode === "INTRADAY" && !isMarketOpen()) {
            return res.status(400).json({ error: "Market is closed. Intraday trading: 09:15 - 15:30 IST. Use Delivery (CNC) for after-hours." });
        }

        const link = await resolveDecisionLink(req.body.decisionId, symbol.toUpperCase());
        if (!link.ok) return res.status(400).json({ error: link.error });

        const result = await executeBuy(req.userId, symbol.toUpperCase(), parseInt(quantity), orderMode, link.decisionId);
        res.json(result);
    } catch (err) {
        // M8: only surface known user-facing messages; hide internal details
        if (isUserError(err.message)) {
            res.status(400).json({ error: err.message });
        } else {
            res.status(500).json({ error: "Trade execution failed" });
        }
    }
});

router.post("/sell", auth, tradeValidation, async (req, res) => {
    try {
        const { symbol, quantity, mode } = req.body;

        const orderMode = (mode || "INTRADAY").toUpperCase();
        if (!VALID_MODES.includes(orderMode)) {
            return res.status(400).json({ error: "Invalid mode. Use INTRADAY or DELIVERY." });
        }

        if (orderMode === "INTRADAY" && !isMarketOpen()) {
            return res.status(400).json({ error: "Market is closed. Intraday trading: 09:15 - 15:30 IST. Use Delivery (CNC) for after-hours." });
        }

        const link = await resolveDecisionLink(req.body.decisionId, symbol.toUpperCase());
        if (!link.ok) return res.status(400).json({ error: link.error });

        const result = await executeSell(req.userId, symbol.toUpperCase(), parseInt(quantity), orderMode, link.decisionId);
        res.json(result);
    } catch (err) {
        if (isUserError(err.message)) {
            res.status(400).json({ error: err.message });
        } else {
            res.status(500).json({ error: "Trade execution failed" });
        }
    }
});

export default router;
