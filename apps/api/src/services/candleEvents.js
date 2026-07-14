import redis from "../config/redis.js";
import { enqueueEvent } from "./eventBackbone.js";
import { MD_CANDLE_CLOSED } from "@zentrade/contracts";
import logger from "../utils/logger.js";

/**
 * md.candle.closed emitter (M4 first citizen).
 *
 * Today candles are fetched on demand, not built continuously, so "a candle
 * closed" is derived: when a fresh daily-resolution fetch comes through, the
 * most recent bar from a PREVIOUS session is a closed candle. A Redis SETNX
 * key makes emission at-most-once per (symbol, session) no matter how many
 * fetch paths fire.
 */

// ranges that resolve to daily bars in fyersREST.RANGE_TO_FYERS
const DAILY_RANGES = new Set(["3mo", "1y"]);
const DEDUPE_TTL_SECS = 48 * 60 * 60;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const istDateString = (epochMs) => {
    const d = new Date(epochMs);
    const ist = new Date(epochMs + IST_OFFSET_MS + d.getTimezoneOffset() * 60 * 1000);
    return `${ist.getFullYear()}-${String(ist.getMonth() + 1).padStart(2, "0")}-${String(ist.getDate()).padStart(2, "0")}`;
};

/**
 * Fire-and-forget: never throws into the caller's request path.
 * `range` is the chart range that produced `candles` (only daily ranges emit).
 */
export const emitClosedDailyCandle = async (symbol, range, candles) => {
    try {
        if (!DAILY_RANGES.has(range) || !Array.isArray(candles) || candles.length === 0) return;

        const today = istDateString(Date.now());
        // walk from the end to the most recent bar belonging to a past session
        for (let i = candles.length - 1; i >= 0 && i >= candles.length - 3; i--) {
            const candle = candles[i];
            if (candle?.close == null) continue;
            const barDate = istDateString(candle.time * 1000);
            if (barDate >= today) continue; // today's bar may still be forming

            const claimed = await redis.set(`evt:candle:${symbol}:${barDate}`, "1", "EX", DEDUPE_TTL_SECS, "NX");
            if (!claimed) return; // already emitted for this session

            await enqueueEvent({
                type: MD_CANDLE_CLOSED.type,
                v: MD_CANDLE_CLOSED.v,
                payload: {
                    venue: "NSE",
                    symbol,
                    resolution: "1d",
                    candle: {
                        time: candle.time,
                        open: candle.open,
                        high: candle.high,
                        low: candle.low,
                        close: candle.close,
                        volume: candle.volume ?? 0,
                    },
                },
            });
            return;
        }
    } catch (err) {
        logger.error("CandleEvents", "emit failed (non-fatal)", { symbol, error: err.message });
    }
};
