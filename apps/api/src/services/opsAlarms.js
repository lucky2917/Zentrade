import { metrics } from "@zentrade/observability";
import redis from "../config/redis.js";
import { pool } from "../config/db.js";
import { sendMail } from "./mailer.js";
import { escapeHtml } from "../utils/escapeHtml.js";
import logger from "../utils/logger.js";

/**
 * Ops alarms (M6): watches the backbone and emails the operator through the
 * existing mailer when something needs a human. Redis SETNX cooldowns keep
 * one incident to one email. The journal-write-failure alarm (M7) plugs into
 * raiseAlarm the same way.
 */

const CHECK_INTERVAL_MS = 60_000;
const COOLDOWN_SECS = 30 * 60;
const OUTBOX_LAG_ALARM_SECS = 60;

let checkTimer = null;

export const raiseAlarm = async (key, subject, detailLines) => {
    const claimed = await redis.set(`alarm:cooldown:${key}`, "1", "EX", COOLDOWN_SECS, "NX");
    if (!claimed) return false;

    metrics.counter("alarms.raised").inc();
    logger.error("OpsAlarms", `ALARM ${key}: ${subject}`);

    const html = `
<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; border: 1px solid #ddd; border-radius: 8px; padding: 24px;">
  <h2 style="margin-top: 0;">${escapeHtml(subject)}</h2>
  ${detailLines.map((l) => `<p>${escapeHtml(l)}</p>`).join("\n  ")}
  <p style="color: #888; font-size: 12px; margin-top: 32px;">ZenTrade ops • cooldown ${COOLDOWN_SECS / 60}min</p>
</div>`;
    await sendMail(process.env.ALERT_EMAIL_TO, `ZenTrade ops alarm: ${subject}`, html);
    return true;
};

export const checkBackboneHealth = async () => {
    try {
        const { rows } = await pool.query(
            `SELECT COUNT(*)::int AS unpublished,
                    COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)::float AS oldest_age_secs
             FROM outbox WHERE published_at IS NULL`
        );
        const { unpublished, oldest_age_secs: oldestAgeSecs } = rows[0];
        const dlqLength = Number(await redis.call("XLEN", "events:dlq").catch(() => 0));

        metrics.gauge("outbox.unpublished").set(unpublished);
        metrics.gauge("outbox.oldest_age_secs").set(Math.round(oldestAgeSecs));
        metrics.gauge("eventbus.dlq_length").set(dlqLength);

        if (oldestAgeSecs > OUTBOX_LAG_ALARM_SECS) {
            await raiseAlarm("outbox_lag", "Outbox relay is lagging", [
                `${unpublished} unpublished events; oldest is ${Math.round(oldestAgeSecs)}s old (threshold ${OUTBOX_LAG_ALARM_SECS}s).`,
                "The relay may be down or Redis unreachable. Check /internal/eventbus/lag and server logs.",
            ]);
        }

        if (dlqLength > 0) {
            await raiseAlarm("dlq_nonempty", "Dead-letter queue has entries", [
                `events:dlq holds ${dlqLength} message(s) that exhausted their retries.`,
                "Inspect them with XRANGE events:dlq - + and decide replay or discard.",
            ]);
        }
    } catch (err) {
        logger.error("OpsAlarms", "health check failed", { error: err.message });
    }
};

export const startOpsAlarms = () => {
    checkTimer = setInterval(checkBackboneHealth, CHECK_INTERVAL_MS);
    logger.info("OpsAlarms", `Backbone health checks every ${CHECK_INTERVAL_MS / 1000}s (outbox lag, DLQ)`);
};

export const stopOpsAlarms = () => {
    if (checkTimer) clearInterval(checkTimer);
};
