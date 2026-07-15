import cron from "node-cron";
import { computeReflections, REFLECTION_SEMANTICS, PRIOR_WINDOW_DAYS } from "@zentrade/domain-evaluation";
import { istDateString } from "@zentrade/kernel";
import { EVAL_REFLECTION_COMPUTED } from "@zentrade/contracts";
import { metrics } from "@zentrade/observability";
import { pool } from "../config/db.js";
import { enqueueEvent } from "./eventBackbone.js";
import logger from "../utils/logger.js";

/**
 * Reflection Engine (M16) — the first reader of the measurement layer.
 *
 * Nightly (16:45 IST, after outcomes 16:00, calibration 16:15, memory 16:30)
 * it reads calibration history and episodic memory and appends a snapshot of
 * structured findings: facts about the self, with references. Never advice.
 * Nothing on the decision path reads reflection tables.
 *
 * Determinism: inputs are append-only tables plus an explicit asOf; the
 * drift baseline is the latest calibration snapshot at least
 * PRIOR_WINDOW_DAYS older than the current one. With no such baseline
 * (cold start) drift findings are honestly absent.
 */

const CELLS_FOR_SNAPSHOT_SQL = `
    SELECT agent_name, agent_version, regime, horizon, n, n_effective, sufficient, brier, hit_rate
    FROM calibration_cells WHERE snapshot_id = $1
`;

const MEMORY_GROUPS_SQL = `
    SELECT symbol, action, regime, horizon,
           (COUNT(*) FILTER (WHERE hit = 'target'))::int AS targets,
           (COUNT(*) FILTER (WHERE hit = 'stop'))::int AS stops
    FROM memories
    WHERE decision_date < $1
    GROUP BY symbol, action, regime, horizon
    HAVING COUNT(*) FILTER (WHERE hit = 'target') >= 2
       AND COUNT(*) FILTER (WHERE hit = 'stop') >= 2
    ORDER BY symbol, action, regime, horizon
`;

const toCell = (row) => ({
    agentName: row.agent_name,
    agentVersion: row.agent_version,
    regime: row.regime,
    horizon: row.horizon,
    n: row.n,
    nEffective: Number(row.n_effective),
    sufficient: row.sufficient,
    brier: row.brier === null ? null : Number(row.brier),
    hitRate: row.hit_rate === null ? null : Number(row.hit_rate),
});

const latestCalibrationSnapshot = async (maxAsOf) => {
    const params = maxAsOf ? [maxAsOf] : [];
    const where = maxAsOf ? "WHERE as_of <= $1" : "";
    const {
        rows: [snapshot],
    } = await pool.query(
        `SELECT id, as_of::text AS as_of FROM calibration_snapshots ${where}
         ORDER BY computed_at DESC, id DESC LIMIT 1`,
        params
    );
    if (!snapshot) return null;
    const { rows } = await pool.query(CELLS_FOR_SNAPSHOT_SQL, [snapshot.id]);
    return { ...snapshot, cells: rows.map(toCell) };
};

const priorBaselineDate = (asOf) => {
    const date = new Date(`${asOf}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - PRIOR_WINDOW_DAYS);
    return date.toISOString().slice(0, 10);
};

export const computeReflectionSnapshot = async ({ asOf = istDateString(new Date()) } = {}) => {
    const started = performance.now();

    const current = await latestCalibrationSnapshot();
    const prior = current ? await latestCalibrationSnapshot(priorBaselineDate(current.as_of)) : null;
    const { rows: memoryGroups } = await pool.query(MEMORY_GROUPS_SQL, [asOf]);

    const findings = computeReflections({
        currentCells: current?.cells ?? [],
        priorCells: prior && prior.id !== current?.id ? prior.cells : null,
        memoryGroups,
    });
    const criticalCount = findings.filter((f) => f.severity === "critical").length;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const {
            rows: [snapshot],
        } = await client.query(
            `INSERT INTO reflection_snapshots (as_of, semantics, finding_count)
             VALUES ($1, $2, $3) RETURNING id`,
            [asOf, REFLECTION_SEMANTICS, findings.length]
        );
        for (const f of findings) {
            await client.query(
                `INSERT INTO reflection_findings (snapshot_id, kind, severity, subject, detail)
                 VALUES ($1, $2, $3, $4, $5)`,
                [snapshot.id, f.kind, f.severity, f.subject, JSON.stringify(f.detail)]
            );
        }
        await enqueueEvent(
            {
                type: EVAL_REFLECTION_COMPUTED.type,
                v: EVAL_REFLECTION_COMPUTED.v,
                payload: {
                    snapshotId: snapshot.id,
                    asOf,
                    semantics: REFLECTION_SEMANTICS,
                    findingCount: findings.length,
                    criticalCount,
                },
            },
            client
        );
        await client.query("COMMIT");
        metrics.counter("reflection.snapshots").inc();
        metrics.gauge("reflection.last_compute_ms").set(Math.round(performance.now() - started));
        logger.info("ReflectionEngine", "snapshot computed", {
            snapshotId: snapshot.id,
            asOf,
            findings: findings.length,
            critical: criticalCount,
        });
        return { snapshotId: snapshot.id, findingCount: findings.length, criticalCount };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
};

export const latestReflection = async () => {
    const {
        rows: [snapshot],
    } = await pool.query(
        `SELECT id, as_of::text AS as_of, semantics, finding_count, computed_at
         FROM reflection_snapshots ORDER BY computed_at DESC, id DESC LIMIT 1`
    );
    if (!snapshot) return { snapshot: null, findings: [] };
    const { rows: findings } = await pool.query(
        `SELECT kind, severity, subject, detail FROM reflection_findings
         WHERE snapshot_id = $1 ORDER BY kind, subject`,
        [snapshot.id]
    );
    return { snapshot, findings };
};

let cronTask = null;

export const startReflectionEngine = () => {
    if (cronTask) return;
    cronTask = cron.schedule(
        "45 16 * * 1-5",
        () =>
            computeReflectionSnapshot().catch((err) =>
                logger.error("ReflectionEngine", "scheduled snapshot failed", { error: err.message })
            ),
        { timezone: "Asia/Kolkata" }
    );
    computeReflectionSnapshot().catch((err) =>
        logger.error("ReflectionEngine", "boot snapshot failed", { error: err.message })
    );
    logger.info("ReflectionEngine", "started (16:45 IST weekdays + boot pass)");
};

export const stopReflectionEngine = () => {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
    }
};
