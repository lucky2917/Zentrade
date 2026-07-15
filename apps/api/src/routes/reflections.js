import { Router } from "express";
import auth from "../middleware/auth.js";
import { latestReflection } from "../services/reflectionEngine.js";
import logger from "../utils/logger.js";

const router = Router();

/**
 * Reflection Read API (M16). Verbatim projection of the latest reflection
 * snapshot: measured facts about the system itself, with references.
 * Read-only; findings are observations, never recommendations.
 */

router.get("/", auth, async (_req, res) => {
    try {
        const { snapshot, findings } = await latestReflection();
        res.json({
            snapshot: snapshot && {
                id: snapshot.id,
                asOf: snapshot.as_of,
                semantics: snapshot.semantics,
                findingCount: snapshot.finding_count,
                computedAt: snapshot.computed_at,
            },
            findings: findings.map((f) => ({
                kind: f.kind,
                severity: f.severity,
                subject: f.subject,
                detail: f.detail,
            })),
        });
    } catch (err) {
        logger.error("ReflectionAPI", "read failed", { error: err.message });
        res.status(500).json({ error: "failed to load reflections" });
    }
});

export default router;
