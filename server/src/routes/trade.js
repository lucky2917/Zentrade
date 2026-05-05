import { Router } from "express";
import auth from "../middleware/auth.js";
import { validate, required, positiveInt } from "../middleware/validate.js";
import { executeBuy, executeSell } from "../services/tradingEngine.js";
import { isMarketOpen } from "../utils/marketHours.js";

const router = Router();

const VALID_MODES = ["INTRADAY", "DELIVERY"];

const tradeValidation = validate({ symbol: [required], quantity: [required, positiveInt] });

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
        res.status(400).json({ error: err.message });
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
        res.status(400).json({ error: err.message });
    }
});

export default router;

/*
 * buy and sell endpoints. intraday (MIS) trades are blocked when
 * the market is closed since they rely on live price movement.
 * delivery (CNC) trades go through anytime — the last traded
 * price from redis is used, just like how real brokers let you
 * place AMO (after market orders) for delivery. mounted at
 * /api/trade in index.js.
 */
