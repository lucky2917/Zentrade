import cron from "node-cron";
import { labelDecisionOutcome, HORIZONS_FOR_MODE } from "@zentrade/domain-evaluation";
import { EVAL_OUTCOME_LABELED } from "@zentrade/contracts";
import { metrics } from "@zentrade/observability";
import { pool } from "../config/db.js";
import { getCandlesForRange } from "./fyers/fyersREST.js";
import { toFyersStockSymbol } from "./fyers/smartWall.js";
import { enqueueEvent } from "./eventBackbone.js";
import logger from "../utils/logger.js";

/**
 * Outcome labeler worker (M11).
 *  - finds decisions missing outcome rows for any of their mode's horizons
 *  - fetches daily candles ONCE per instrument (provider injectable for
 *    tests/replay), hands everything to the pure domain labeler
 *  - inserts the outcome and its event in one transaction; UNIQUE
 *    (decision_id, horizon) + ON CONFLICT DO NOTHING = idempotency
 * Runs nightly after close and once at boot (both idempotent).
 */

const DATA_SOURCE = "fyers:candles:D";
const BATCH_LIMIT = 500;

const defaultCandleProvider = async (symbol) => {
    const candles = await getCandlesForRange(toFyersStockSymbol(symbol), "1mo");
    return (candles ?? []).map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
};

const pendingHorizonsFor = (decision, existing) =>
    (HORIZONS_FOR_MODE[decision.mode] ?? []).filter((h) => !existing.has(h.key));

export const labelPendingOutcomes = async ({ candleProvider = defaultCandleProvider, now = () => new Date() } = {}) => {
    const { rows: decisions } = await pool.query(
        `SELECT d.id, d.instrument_id, d.action, d.mode, d.entry_minor, d.target_minor, d.stop_minor,
                d.created_at, i.symbol, i.venue,
                COALESCE(json_agg(o.horizon) FILTER (WHERE o.horizon IS NOT NULL), '[]') AS labeled
         FROM decisions d
         JOIN instruments i ON i.id = d.instrument_id
         LEFT JOIN outcomes o ON o.decision_id = d.id
         GROUP BY d.id, i.symbol, i.venue
         HAVING COUNT(o.id) < (CASE d.mode WHEN 'INTRADAY' THEN 1 ELSE 2 END)
         ORDER BY d.created_at
         LIMIT $1`,
        [BATCH_LIMIT]
    );
    if (decisions.length === 0) return { labeled: 0, pending: 0 };

    const candleCache = new Map();
    let labeled = 0;
    let pending = 0;

    for (const row of decisions) {
        const existing = new Set(row.labeled);
        const horizons = pendingHorizonsFor(row, existing);
        if (horizons.length === 0) continue;

        if (!candleCache.has(row.symbol)) {
            try {
                candleCache.set(row.symbol, await candleProvider(row.symbol));
            } catch (err) {
                logger.error("OutcomeLabeler", `candles unavailable for ${row.symbol}`, { error: err.message });
                candleCache.set(row.symbol, []);
            }
        }
        const candles = candleCache.get(row.symbol);

        const decision = {
            action: row.action,
            mode: row.mode,
            entryMinor: row.entry_minor === null ? null : Number(row.entry_minor),
            targetMinor: row.target_minor === null ? null : Number(row.target_minor),
            stopMinor: row.stop_minor === null ? null : Number(row.stop_minor),
            createdAt: new Date(row.created_at).toISOString(),
        };

        for (const horizon of horizons) {
            const label = labelDecisionOutcome(decision, horizon, candles);
            if (!label.ready) {
                pending++;
                continue;
            }

            const client = await pool.connect();
            try {
                await client.query("BEGIN");
                const { rows: inserted } = await client.query(
                    `INSERT INTO outcomes (decision_id, horizon, basis, hit, entry_minor, exit_minor, realized_return_bps, sessions_used, data_source)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                     ON CONFLICT (decision_id, horizon) DO NOTHING
                     RETURNING id`,
                    [row.id, label.horizon, label.basis, label.hit, label.entryMinor, label.exitMinor, label.realizedReturnBps, label.sessionsUsed, DATA_SOURCE]
                );
                if (inserted.length > 0) {
                    await enqueueEvent(
                        {
                            type: EVAL_OUTCOME_LABELED.type,
                            v: EVAL_OUTCOME_LABELED.v,
                            payload: {
                                outcomeId: inserted[0].id,
                                decisionId: row.id,
                                instrumentId: row.instrument_id,
                                horizon: label.horizon,
                                basis: label.basis,
                                hit: label.hit,
                                realizedReturnBps: label.realizedReturnBps,
                                entryMinor: label.entryMinor,
                                exitMinor: label.exitMinor,
                                sessionsUsed: label.sessionsUsed,
                            },
                        },
                        client
                    );
                    labeled++;
                }
                await client.query("COMMIT");
            } catch (err) {
                await client.query("ROLLBACK").catch(() => {});
                logger.error("OutcomeLabeler", `label failed for decision ${row.id} ${horizon.key}`, { error: err.message });
            } finally {
                client.release();
            }
        }
    }

    metrics.counter("outcomes.labeled").inc(labeled);
    metrics.gauge("outcomes.pending").set(pending);
    logger.info("OutcomeLabeler", `pass complete: ${labeled} labeled, ${pending} awaiting data`, { at: now().toISOString() });
    return { labeled, pending };
};

let cronTask = null;

export const startOutcomeLabeler = () => {
    // 16:00 IST Mon-Fri — after square-off (15:25) and session close (15:30)
    cronTask = cron.schedule("0 16 * * 1-5", () => labelPendingOutcomes().catch((err) =>
        logger.error("OutcomeLabeler", "scheduled pass failed", { error: err.message })
    ), { timezone: "Asia/Kolkata" });

    // boot reconcile: catch anything missed while the instance slept
    labelPendingOutcomes().catch((err) => logger.error("OutcomeLabeler", "boot pass failed", { error: err.message }));
    logger.info("OutcomeLabeler", "Scheduled nightly at 16:00 IST + boot reconcile");
};

export const stopOutcomeLabeler = () => {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
    }
};
