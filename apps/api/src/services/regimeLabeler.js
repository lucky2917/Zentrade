import cron from "node-cron";
import { classifyRegime, MIN_SESSIONS, REGIME_TAXONOMY } from "@zentrade/domain-marketdata";
import { MD_REGIME_LABELED } from "@zentrade/contracts";
import { metrics } from "@zentrade/observability";
import { pool } from "../config/db.js";
import { getCandles } from "./fyers/fyersREST.js";
import { enqueueEvent } from "./eventBackbone.js";
import logger from "../utils/logger.js";

/**
 * Regime labeler worker (M12). Classifies the NSE benchmark session daily
 * (15:45 IST, before the 16:00 outcome pass) and backfills history at boot.
 *
 * Immutability note: historical journal rows are APPEND-ONLY — they are not
 * retro-stamped. The regimes table is the source of truth; consumers resolve
 * any decision's regime by (venue, decision date, taxonomy) join via
 * regimeForDate(). New decision_requests get a convenience stamp at insert
 * time (decisionJournal).
 */

const VENUE = "NSE";
const BENCHMARK = "NSE:NIFTY50-INDEX";
const BACKFILL_YEARS = 5;

const isoDate = (d) => d.toISOString().slice(0, 10);

const defaultCandleProvider = async (years) => {
    const to = new Date();
    const from = new Date();
    from.setFullYear(from.getFullYear() - years);
    // add headroom so the earliest classifiable day has its MIN_SESSIONS window
    from.setDate(from.getDate() - 120);
    const candles = await getCandles(BENCHMARK, "D", isoDate(from), isoDate(to));
    return (candles ?? []).filter((c) => c?.close != null).map(({ time, close }) => ({ time, close }));
};

const insertLabel = async (label) => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const { rows } = await client.query(
            `INSERT INTO regimes (venue, cal_date, taxonomy, trend, vol_bucket, breadth, composite, realized_vol_pct, inputs_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (venue, cal_date, taxonomy) DO NOTHING
             RETURNING cal_date`,
            [VENUE, label.calDate, label.taxonomy, label.trend, label.volBucket, label.breadth, label.composite, label.realizedVolPct, label.inputsHash]
        );
        if (rows.length > 0) {
            await enqueueEvent(
                {
                    type: MD_REGIME_LABELED.type,
                    v: MD_REGIME_LABELED.v,
                    payload: {
                        venue: VENUE,
                        calDate: label.calDate,
                        taxonomy: label.taxonomy,
                        trend: label.trend,
                        volBucket: label.volBucket,
                        breadth: label.breadth,
                        composite: label.composite,
                        inputsHash: label.inputsHash,
                    },
                },
                client
            );
        }
        await client.query("COMMIT");
        return rows.length;
    } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
    } finally {
        client.release();
    }
};

/**
 * Classify every session in the provided history that has a full window and
 * no existing row. Idempotent; used by both the nightly pass (labels the
 * newest session) and the boot backfill (labels everything missing).
 */
export const backfillRegimes = async ({ candleProvider = defaultCandleProvider, years = BACKFILL_YEARS } = {}) => {
    const candles = await candleProvider(years);
    if (candles.length < MIN_SESSIONS) {
        logger.warn("RegimeLabeler", `insufficient benchmark history (${candles.length} sessions), skipping pass`);
        return { labeled: 0, sessions: candles.length };
    }
    const sorted = [...candles].sort((a, b) => a.time - b.time);

    const { rows: existingRows } = await pool.query(
        "SELECT cal_date::text AS d FROM regimes WHERE venue = $1 AND taxonomy = $2",
        [VENUE, REGIME_TAXONOMY]
    );
    const existing = new Set(existingRows.map((r) => r.d));

    let labeled = 0;
    for (let end = MIN_SESSIONS; end <= sorted.length; end++) {
        const label = classifyRegime(sorted.slice(end - MIN_SESSIONS, end));
        if (!label.ready) continue;
        if (existing.has(label.calDate)) continue;
        labeled += await insertLabel(label);
    }

    metrics.counter("regimes.labeled").inc(labeled);
    logger.info("RegimeLabeler", `pass complete: ${labeled} sessions labeled (${REGIME_TAXONOMY})`);
    return { labeled, sessions: sorted.length };
};

/** Resolve the regime effective on a given date (latest label at or before it). */
export const regimeForDate = async (date, taxonomy = REGIME_TAXONOMY) => {
    const { rows } = await pool.query(
        `SELECT cal_date::text AS cal_date, taxonomy, composite FROM regimes
         WHERE venue = $1 AND taxonomy = $2 AND cal_date <= $3
         ORDER BY cal_date DESC LIMIT 1`,
        [VENUE, taxonomy, date]
    );
    return rows[0] ?? null;
};

/** Current regime tag for stamping new journal rows; cached briefly. */
let stampCache = { at: 0, value: null };
export const currentRegimeTag = async () => {
    if (Date.now() - stampCache.at < 10 * 60 * 1000) return stampCache.value;
    const row = await regimeForDate(isoDate(new Date()));
    stampCache = { at: Date.now(), value: row ? { taxonomy: row.taxonomy, label: row.composite } : null };
    return stampCache.value;
};

let cronTask = null;

export const startRegimeLabeler = () => {
    // 15:45 IST Mon-Fri: after close (15:30), before the outcome pass (16:00)
    cronTask = cron.schedule("45 15 * * 1-5", () => backfillRegimes({ years: 1 }).catch((err) =>
        logger.error("RegimeLabeler", "scheduled pass failed", { error: err.message })
    ), { timezone: "Asia/Kolkata" });

    backfillRegimes().catch((err) => logger.error("RegimeLabeler", "boot backfill failed", { error: err.message }));
    logger.info("RegimeLabeler", "Scheduled daily at 15:45 IST + boot backfill");
};

export const stopRegimeLabeler = () => {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
    }
};
