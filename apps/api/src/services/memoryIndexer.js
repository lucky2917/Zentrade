import cron from "node-cron";
import { buildEpisode } from "@zentrade/domain-memory";
import { MEM_EPISODE_FORMED } from "@zentrade/contracts";
import { metrics } from "@zentrade/observability";
import { pool } from "../config/db.js";
import { enqueueEvent } from "./eventBackbone.js";
import logger from "../utils/logger.js";

/**
 * Memory Indexer (M14) — forms episodic memories over labeled outcomes.
 *
 * Memory is an index over experience; the journal stays the single source
 * of truth. Formation is a set-difference pass (outcomes without episodes),
 * so it is idempotent, replay-safe, and picks up anything missed while the
 * process was down. Runs nightly at 16:30 IST after outcomes (16:00) and
 * calibration (16:15), plus a boot pass.
 */

const UNINDEXED_SQL = `
    SELECT
        o.id AS outcome_id,
        o.horizon,
        o.basis,
        o.hit,
        o.realized_return_bps,
        d.id AS decision_id,
        d.request_id,
        d.instrument_id,
        d.action,
        d.mode,
        d.confidence,
        (d.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS decision_date,
        i.symbol,
        i.venue,
        COALESCE(rg.composite, 'unlabeled') AS regime,
        COALESCE(ARRAY(
            SELECT ar.output->>'signal' FROM agent_runs ar
            WHERE ar.request_id = d.request_id AND ar.status = 'ok' AND ar.agent_name <> 'synthesizer'
            ORDER BY ar.agent_name
        ), '{}') AS stances
    FROM outcomes o
    JOIN decisions d ON d.id = o.decision_id
    JOIN instruments i ON i.id = d.instrument_id
    LEFT JOIN LATERAL (
        SELECT composite FROM regimes
        WHERE venue = 'NSE' AND taxonomy = 'nse_equity_v1'
          AND cal_date <= (d.created_at AT TIME ZONE 'Asia/Kolkata')::date
        ORDER BY cal_date DESC LIMIT 1
    ) rg ON TRUE
    LEFT JOIN memories m ON m.outcome_id = o.id
    WHERE m.id IS NULL
    ORDER BY o.labeled_at, o.id
`;

const formOne = async (row) => {
    const episode = buildEpisode({
        decisionId: row.decision_id,
        horizon: row.horizon,
        symbol: row.symbol,
        venue: row.venue,
        action: row.action,
        mode: row.mode,
        confidence: row.confidence,
        regime: row.regime,
        decisionDate: row.decision_date,
        basis: row.basis,
        hit: row.hit,
        realizedReturnBps: row.realized_return_bps === null ? null : Number(row.realized_return_bps),
        stances: row.stances,
    });

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const {
            rows: [memory],
        } = await client.query(
            `INSERT INTO memories
               (memory_key, semantics, decision_id, request_id, outcome_id, instrument_id,
                horizon, symbol, venue, action, mode, confidence, regime, hit, basis,
                realized_return_bps, decision_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
             ON CONFLICT (memory_key) DO NOTHING
             RETURNING id`,
            [
                episode.memoryKey,
                episode.semantics,
                row.decision_id,
                row.request_id,
                row.outcome_id,
                row.instrument_id,
                row.horizon,
                row.symbol,
                row.venue,
                row.action,
                row.mode,
                row.confidence,
                row.regime,
                row.hit,
                row.basis,
                row.realized_return_bps,
                row.decision_date,
            ]
        );
        if (!memory) {
            await client.query("ROLLBACK");
            return false;
        }
        await enqueueEvent(
            {
                type: MEM_EPISODE_FORMED.type,
                v: MEM_EPISODE_FORMED.v,
                payload: {
                    memoryId: memory.id,
                    memoryKey: episode.memoryKey,
                    semantics: episode.semantics,
                    decisionId: row.decision_id,
                    outcomeId: row.outcome_id,
                    horizon: row.horizon,
                    regime: row.regime,
                    hit: row.hit,
                },
            },
            client
        );
        await client.query("COMMIT");
        return true;
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
};

export const formEpisodes = async () => {
    const started = performance.now();
    const { rows } = await pool.query(UNINDEXED_SQL);
    let formed = 0;
    for (const row of rows) {
        if (await formOne(row)) formed += 1;
    }
    const elapsed = performance.now() - started;
    if (formed > 0) {
        metrics.counter("memory.episodes_formed").inc(formed);
        metrics.gauge("memory.last_write_ms_per_episode").set(Math.round(elapsed / formed));
        logger.info("MemoryIndexer", "episodes formed", {
            formed,
            msPerEpisode: Math.round(elapsed / formed),
        });
    }
    return { formed };
};

let cronTask = null;

export const startMemoryIndexer = () => {
    if (cronTask) return;
    cronTask = cron.schedule(
        "30 16 * * 1-5",
        () =>
            formEpisodes().catch((err) =>
                logger.error("MemoryIndexer", "scheduled pass failed", { error: err.message })
            ),
        { timezone: "Asia/Kolkata" }
    );
    formEpisodes().catch((err) => logger.error("MemoryIndexer", "boot pass failed", { error: err.message }));
    logger.info("MemoryIndexer", "started (16:30 IST weekdays + boot pass)");
};

export const stopMemoryIndexer = () => {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
    }
};
