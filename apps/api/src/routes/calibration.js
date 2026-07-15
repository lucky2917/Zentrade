import { Router } from "express";
import auth from "../middleware/auth.js";
import { latestCalibration } from "../services/calibrationEngine.js";
import logger from "../utils/logger.js";

const router = Router();

/**
 * Calibration Read API (M13). Same constitution as the journal API:
 * read-only, verbatim projection of the latest snapshot. Insufficient
 * cells arrive with null metrics — the API never invents a number.
 */

router.get("/", auth, async (_req, res) => {
    try {
        const { snapshot, cells } = await latestCalibration();
        res.json({
            snapshot: snapshot && {
                id: snapshot.id,
                asOf: snapshot.as_of,
                semantics: snapshot.semantics,
                sampleCount: snapshot.sample_count,
                cellCount: snapshot.cell_count,
                computedAt: snapshot.computed_at,
            },
            cells: cells.map((c) => ({
                agentName: c.agent_name,
                agentVersion: c.agent_version,
                regime: c.regime,
                horizon: c.horizon,
                n: c.n,
                nEffective: Number(c.n_effective),
                sufficient: c.sufficient,
                brier: c.brier === null ? null : Number(c.brier),
                hitRate: c.hit_rate === null ? null : Number(c.hit_rate),
            })),
        });
    } catch (err) {
        logger.error("CalibrationAPI", "read failed", { error: err.message });
        res.status(500).json({ error: "failed to load calibration" });
    }
});

export default router;
