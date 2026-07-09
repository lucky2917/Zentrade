import { Router } from "express";
import auth from "../middleware/auth.js";
import { validate, required, positiveInt } from "../middleware/validate.js";
import { executeBuy, executeSell } from "../services/tradingEngine.js";
import { isMarketOpen } from "../utils/marketHours.js";

const router = Router();

const VALID_MODES = ["INTRADAY", "DELIVERY"];

const tradeValidation = validate({ symbol: [required], quantity: [required, positiveInt] });

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

        const result = await executeBuy(req.userId, symbol.toUpperCase(), parseInt(quantity), orderMode);
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

        const result = await executeSell(req.userId, symbol.toUpperCase(), parseInt(quantity), orderMode);
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
