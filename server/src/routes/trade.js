import { Router } from "express";
import auth from "../middleware/auth.js";
import { executeBuy, executeSell } from "../services/tradingEngine.js";
import { isMarketOpen } from "../utils/marketHours.js";

const router = Router();

const VALID_MODES = ["INTRADAY", "DELIVERY"];

router.post("/buy", auth, async (req, res) => {
    try {
        if (!isMarketOpen()) {
            return res.status(400).json({ error: "Market is closed. Trading hours: 09:15 - 15:30 IST" });
        }

        const { symbol, quantity, mode } = req.body;
        if (!symbol || !quantity) {
            return res.status(400).json({ error: "Symbol and quantity are required" });
        }

        const orderMode = (mode || "INTRADAY").toUpperCase();
        if (!VALID_MODES.includes(orderMode)) {
            return res.status(400).json({ error: "Invalid mode. Use INTRADAY or DELIVERY." });
        }

        const result = await executeBuy(req.userId, symbol.toUpperCase(), parseInt(quantity), orderMode);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

router.post("/sell", auth, async (req, res) => {
    try {
        if (!isMarketOpen()) {
            return res.status(400).json({ error: "Market is closed. Trading hours: 09:15 - 15:30 IST" });
        }

        const { symbol, quantity, mode } = req.body;
        if (!symbol || !quantity) {
            return res.status(400).json({ error: "Symbol and quantity are required" });
        }

        const orderMode = (mode || "INTRADAY").toUpperCase();
        if (!VALID_MODES.includes(orderMode)) {
            return res.status(400).json({ error: "Invalid mode. Use INTRADAY or DELIVERY." });
        }

        const result = await executeSell(req.userId, symbol.toUpperCase(), parseInt(quantity), orderMode);
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

export default router;

/*
 * buy and sell endpoints. accepts a mode field in the request body
 * — either INTRADAY (5x leverage, auto square-off at EOD) or
 * DELIVERY (full payment, hold forever). defaults to INTRADAY if
 * not specified. validates the mode before passing it through to
 * the trading engine. both routes still check market hours first.
 * mounted at /api/trade in index.js.
 */
