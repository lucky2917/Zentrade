import { Router } from "express";
import auth from "../middleware/auth.js";
import { retrieveMemories } from "../services/memoryRetrieval.js";
import { MAX_RETRIEVAL } from "@zentrade/domain-memory";
import logger from "../utils/logger.js";

const router = Router();

/**
 * Memory Retrieval API (M15). Read-only recall of historical observations.
 * Inputs are allowlisted; outputs are index rows verbatim plus narratives
 * regenerated from journal facts. Nothing here is advice.
 */

const SYMBOL_PATTERN = /^[A-Z0-9&-]{1,32}$/;
const REGIME_PATTERN = /^(UP|DOWN|SIDEWAYS)_(LOW|MID|HIGH)VOL$|^unlabeled$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ACTIONS = new Set(["BUY", "SELL", "HOLD"]);
const MODES = new Set(["INTRADAY", "SWING", "LONGTERM"]);

router.get("/", auth, async (req, res) => {
    const { symbol, regime, action, mode, asOf, limit } = req.query;

    if (!symbol && !regime) return res.status(400).json({ error: "symbol or regime is required" });
    if (symbol && !SYMBOL_PATTERN.test(String(symbol))) return res.status(400).json({ error: "invalid symbol" });
    if (regime && !REGIME_PATTERN.test(String(regime))) return res.status(400).json({ error: "invalid regime" });
    if (action && !ACTIONS.has(String(action))) return res.status(400).json({ error: "invalid action" });
    if (mode && !MODES.has(String(mode))) return res.status(400).json({ error: "invalid mode" });
    if (asOf && (!DATE_PATTERN.test(String(asOf)) || Number.isNaN(Date.parse(String(asOf)))))
        return res.status(400).json({ error: "invalid asOf" });
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_RETRIEVAL))
        return res.status(400).json({ error: `limit must be 1..${MAX_RETRIEVAL}` });

    try {
        const result = await retrieveMemories({
            symbol: symbol ? String(symbol) : undefined,
            regime: regime ? String(regime) : undefined,
            action: action ? String(action) : undefined,
            mode: mode ? String(mode) : undefined,
            asOf: asOf ? String(asOf) : undefined,
            limit: parsedLimit,
        });
        res.json(result);
    } catch (err) {
        logger.error("MemoryAPI", "retrieval failed", { error: err.message });
        res.status(500).json({ error: "failed to retrieve memories" });
    }
});

export default router;
