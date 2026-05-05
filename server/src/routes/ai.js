import { Router } from "express";
import auth from "../middleware/auth.js";
import { STOCK_MAP } from "../config/stocks.js";
import { analyseStock } from "../services/aiEngine.js";

const router = Router();

router.get("/analyse/:symbol", auth, async (req, res) => {
    const symbol = req.params.symbol.toUpperCase();

    if (!STOCK_MAP.has(symbol)) {
        return res.status(400).json({
            error: `${symbol} is not available on Zentrade. Only our 50 stocks are supported.`,
        });
    }

    try {
        const result = await analyseStock(symbol);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
