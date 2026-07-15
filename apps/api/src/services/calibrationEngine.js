import cron from "node-cron";
import {
    computeCalibrationCells,
    decisionSuccess,
    stanceSuccess,
    CALIBRATION_SEMANTICS,
} from "@zentrade/domain-evaluation";
import { istDateString } from "@zentrade/kernel";
import { EVAL_CALIBRATION_UPDATED } from "@zentrade/contracts";
import { metrics } from "@zentrade/observability";
import { pool } from "../config/db.js";
import { enqueueEvent } from "./eventBackbone.js";
import logger from "../utils/logger.js";

/**
 * Calibration Engine (M13) — measurement, never influence.
 *
 * Nightly (16:15 IST, after the 16:00 outcome pass) recomputes calibration
 * from ALL scoreable outcomes and appends a new snapshot. Snapshots are
 * append-only: the history of self-assessment is itself permanent evidence.
 * Nothing on the decision path reads these tables. Adaptation comes later,
 * measured first.
 *
 * Regimes are resolved uniformly by date-join against the regimes table
 * (same law as regimeForDate), so pre-M12 decisions calibrate identically
 * to stamped ones and a backfilled regime history is picked up for free.
 */

const CONFIDENCE_BUCKETS = new Set(["HIGH", "MEDIUM", "LOW"]);

const SAMPLE_SQL = `
    SELECT
        o.horizon,
        o.basis,
        o.hit,
        o.realized_return_bps,
        d.action,
        d.confidence AS decision_confidence,
        ar.agent_name,
        ar.agent_version,
        ar.output->>'signal' AS stance,
        ar.output->>'confidence' AS run_confidence,
        (d.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS decision_date,
        COALESCE(rg.composite, 'unlabeled') AS regime
    FROM outcomes o
    JOIN decisions d ON d.id = o.decision_id
    JOIN agent_runs ar ON ar.request_id = d.request_id AND ar.status = 'ok'
    LEFT JOIN LATERAL (
        SELECT composite FROM regimes
        WHERE venue = 'NSE' AND taxonomy = 'nse_equity_v1'
          AND cal_date <= (d.created_at AT TIME ZONE 'Asia/Kolkata')::date
        ORDER BY cal_date DESC LIMIT 1
    ) rg ON TRUE
    WHERE o.basis <> 'abstain'
`;

const ageDays = (asOf, decisionDate) => {
    const days = Math.round((Date.parse(asOf) - Date.parse(decisionDate)) / 86_400_000);
    return Math.max(0, days);
};

const toSample = (row, asOf) => {
    const realizedReturnBps = row.realized_return_bps === null ? null : Number(row.realized_return_bps);
    const isSynthesizer = row.agent_name === "synthesizer";
    const success = isSynthesizer
        ? decisionSuccess({ basis: row.basis, hit: row.hit, realizedReturnBps })
        : stanceSuccess(row.stance ?? "", { basis: row.basis, realizedReturnBps, decisionAction: row.action });
    if (success === null) return null;

    const confidence = isSynthesizer ? row.decision_confidence : row.run_confidence;
    if (!CONFIDENCE_BUCKETS.has(confidence)) return null;

    return {
        agentName: row.agent_name,
        agentVersion: row.agent_version,
        regime: row.regime,
        horizon: row.horizon,
        confidence,
        success,
        ageDays: ageDays(asOf, row.decision_date),
    };
};

export const gatherCalibrationSamples = async (asOf) => {
    const { rows } = await pool.query(SAMPLE_SQL);
    return rows.map((row) => toSample(row, asOf)).filter((s) => s !== null);
};

export const computeCalibrationSnapshot = async ({ asOf = istDateString(new Date()) } = {}) => {
    const started = performance.now();
    const samples = await gatherCalibrationSamples(asOf);
    const cells = computeCalibrationCells(samples);
    const sufficientCells = cells.filter((c) => c.sufficient).length;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const {
            rows: [snapshot],
        } = await client.query(
            `INSERT INTO calibration_snapshots (as_of, semantics, sample_count, cell_count)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [asOf, CALIBRATION_SEMANTICS, samples.length, cells.length]
        );

        for (const cell of cells) {
            await client.query(
                `INSERT INTO calibration_cells
                   (snapshot_id, agent_name, agent_version, regime, horizon,
                    n, n_effective, sufficient, brier, hit_rate)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [
                    snapshot.id,
                    cell.agentName,
                    cell.agentVersion,
                    cell.regime,
                    cell.horizon,
                    cell.n,
                    cell.nEffective,
                    cell.sufficient,
                    cell.brier,
                    cell.hitRate,
                ]
            );
        }

        await enqueueEvent(
            {
                type: EVAL_CALIBRATION_UPDATED.type,
                v: EVAL_CALIBRATION_UPDATED.v,
                payload: {
                    snapshotId: snapshot.id,
                    asOf,
                    semantics: CALIBRATION_SEMANTICS,
                    cellCount: cells.length,
                    sufficientCells,
                    sampleCount: samples.length,
                },
            },
            client
        );

        await client.query("COMMIT");
        metrics.counter("calibration.snapshots").inc();
        metrics.gauge("calibration.last_compute_ms").set(Math.round(performance.now() - started));
        logger.info("CalibrationEngine", "snapshot computed", {
            snapshotId: snapshot.id,
            asOf,
            samples: samples.length,
            cells: cells.length,
            sufficient: sufficientCells,
        });
        return { snapshotId: snapshot.id, sampleCount: samples.length, cellCount: cells.length, sufficientCells };
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
};

export const latestCalibration = async () => {
    const {
        rows: [snapshot],
    } = await pool.query(
        `SELECT id, as_of::text AS as_of, semantics, sample_count, cell_count, computed_at
         FROM calibration_snapshots ORDER BY computed_at DESC, id DESC LIMIT 1`
    );
    if (!snapshot) return { snapshot: null, cells: [] };
    const { rows: cells } = await pool.query(
        `SELECT agent_name, agent_version, regime, horizon, n, n_effective, sufficient, brier, hit_rate
         FROM calibration_cells WHERE snapshot_id = $1
         ORDER BY agent_name, agent_version, regime, horizon`,
        [snapshot.id]
    );
    return { snapshot, cells };
};

let cronTask = null;

export const startCalibrationEngine = () => {
    if (cronTask) return;
    cronTask = cron.schedule(
        "15 16 * * 1-5",
        () =>
            computeCalibrationSnapshot().catch((err) =>
                logger.error("CalibrationEngine", "scheduled snapshot failed", { error: err.message })
            ),
        { timezone: "Asia/Kolkata" }
    );
    computeCalibrationSnapshot().catch((err) =>
        logger.error("CalibrationEngine", "boot snapshot failed", { error: err.message })
    );
    logger.info("CalibrationEngine", "started (16:15 IST weekdays + boot pass)");
};

export const stopCalibrationEngine = () => {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
    }
};
