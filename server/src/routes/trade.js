import { Router } from "express";
import auth from "../middleware/auth.js";
import { executeBuy, executeSell } from "../services/tradingEngine.js";
import { isMarketOpen } from "../utils/marketHours.js";

const router = Router();

router.post("/buy", auth, async (req, res) => {
    try {
        if (!isMarketOpen()) {
            return res.status(400).json({ error: "Market is closed. Trading hours: 09:15 - 15:30 IST" });
        }

        const { symbol, quantity } = req.body;
        if (!symbol || !quantity) {
            return res.status(400).json({ error: "Symbol and quantity are required" });
        }

        const result = await executeBuy(req.userId, symbol.toUpperCase(), parseInt(quantity));
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

        const { symbol, quantity } = req.body;
        if (!symbol || !quantity) {
            return res.status(400).json({ error: "Symbol and quantity are required" });
        }

        const result = await executeSell(req.userId, symbol.toUpperCase(), parseInt(quantity));
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

export default router;
