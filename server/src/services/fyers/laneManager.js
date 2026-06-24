import cron from "node-cron";
import redis from "../../config/redis.js";
import logger from "../../utils/logger.js";
import { isMarketOpen } from "../../utils/marketHours.js";
import { getQuotes, getMarketDepth } from "./fyersREST.js";
import { subscribeRaw } from "./fyersWebSocket.js";
import { sanitiseTick } from "./smartWall.js";
import { getRateLimiter, isRestAllowed, trackCall, getCurrentMode } from "./rateLimiter.js";
import { getCurrentTier1 } from "./symbolManager.js";
import { screenSymbol } from "../screener.js";
import { sendTradeAlert, passesAlertThreshold } from "../alertService.js";
import { analyseStock } from "../aiEngine.js";
import { STOCKS } from "../../config/stocks.js";
import { ALL_SYMBOLS, TIER_3 } from "../../config/watchlist.js";

const SLOW_LANE_BATCH_SIZE = 50;
const DEPTH_LANE_INTERVAL_MS = 15000;
const DEPTH_BATCH_SIZE = 10;
const DEPTH_INTER_BATCH_DELAY_MS = 2500;
const DEPTH_TTL = 10;
const WS_EXCLUDE_COUNT = 18;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let depthLaneTimer = null;
let depthLaneRunning = false;
const laneStatus = {
    fastLane: "not started",
    slowLane: "not started",
    depthLane: "not started",
};

const toFyersStockSymbol = (root) => `NSE:${root}-EQ`;
const toRootSymbol = (fyersSymbol) => fyersSymbol.replace(/^(NSE|BSE):/, "").replace(/-EQ$/, "");

const getWsSubscriptionTargets = () => {
    const existingFyers = new Set([
        ...STOCKS.map((s) => toFyersStockSymbol(s.symbol)),
        "NSE:NIFTY50-INDEX",
        "NSE:NIFTYBANK-INDEX",
        "BSE:SENSEX-INDEX",
    ]);

    const newOnly = ALL_SYMBOLS.filter((s) => !existingFyers.has(s));
    const tier3NewOnly = newOnly.filter((s) => TIER_3.includes(s));
    const excluded = new Set(tier3NewOnly.slice(-WS_EXCLUDE_COUNT));

    return newOnly.filter((s) => !excluded.has(s));
};

const startFastLane = () => {
    const targets = getWsSubscriptionTargets();
    if (targets.length > 0) subscribeRaw(targets);

    laneStatus.fastLane = `running, +${targets.length} watchlist symbols added to existing WS feed`;
    logger.info("LaneManager", `Fast lane: added ${targets.length} watchlist symbols to existing WS subscription`);
};

const fetchAllQuotesInBatches = async (symbols) => {
    const results = [];
    for (let i = 0; i < symbols.length; i += SLOW_LANE_BATCH_SIZE) {
        const batch = symbols.slice(i, i + SLOW_LANE_BATCH_SIZE);

        const allowed = await isRestAllowed();
        if (!allowed) {
            logger.error("LaneManager", "Slow lane aborted, REST budget exhausted");
            break;
        }

        const response = await getRateLimiter().schedule(() => getQuotes(batch));
        await trackCall();
        if (!response || response.s !== "ok" || !Array.isArray(response.d)) continue;

        results.push(...response.d);
    }
    return results;
};

const runSlowLane = async () => {
    if (!isMarketOpen()) return;

    const quoteEntries = await fetchAllQuotesInBatches(ALL_SYMBOLS);
    let screened = 0;
    let alerted = 0;

    for (const entry of quoteEntries) {
        if (entry.s !== "ok" || !entry.v) continue;
        const sanitised = sanitiseTick({ ...entry, ...entry.v });
        if (!sanitised) continue;

        try {
            const passed = await screenSymbol(entry.n, sanitised.price, sanitised.volume);
            if (!passed) continue;
            screened++;

            const analysis = await analyseStock(sanitised.symbol);
            if (passesAlertThreshold(analysis)) {
                await sendTradeAlert(sanitised.symbol, analysis);
                alerted++;
            }
        } catch (err) {
            logger.error("LaneManager", `Slow lane analysis failed for ${entry.n}`, { error: err.message });
        }
    }

    laneStatus.slowLane = `last run: ${quoteEntries.length} quotes, ${screened} passed screen, ${alerted} alerts`;
    logger.info("LaneManager", `Slow lane complete: ${quoteEntries.length} quotes, ${screened} passed screen, ${alerted} alerts sent`);
};

const fetchDepthForBatch = async (batch) => {
    for (const fyersSymbol of batch) {
        const allowed = await isRestAllowed();
        if (!allowed) {
            logger.error("LaneManager", "Depth lane aborted, REST budget exhausted");
            return;
        }

        try {
            const response = await getRateLimiter().schedule(() => getMarketDepth(fyersSymbol));
            await trackCall();
            if (response && response.s === "ok") {
                await redis.set(`depth:${toRootSymbol(fyersSymbol)}`, JSON.stringify(response), "EX", DEPTH_TTL);
            }
        } catch (err) {
            logger.error("LaneManager", `Depth fetch failed for ${fyersSymbol}`, { error: err.message });
        }
    }
};

const runDepthLaneCycle = async () => {
    if (depthLaneRunning) return;
    depthLaneRunning = true;

    try {
        if (!isMarketOpen()) return;

        const mode = await getCurrentMode();
        if (mode !== "TURBO" && mode !== "HIGH") {
            laneStatus.depthLane = `skipped (mode: ${mode})`;
            return;
        }

        const tier1 = await getCurrentTier1();
        const batch1 = tier1.slice(0, DEPTH_BATCH_SIZE);
        const batch2 = tier1.slice(DEPTH_BATCH_SIZE, DEPTH_BATCH_SIZE * 2);

        await fetchDepthForBatch(batch1);
        await sleep(DEPTH_INTER_BATCH_DELAY_MS);
        await fetchDepthForBatch(batch2);

        laneStatus.depthLane = `running (mode: ${mode}), last cycle covered ${batch1.length + batch2.length} symbols`;
    } finally {
        depthLaneRunning = false;
    }
};

const startDepthLane = () => {
    depthLaneTimer = setInterval(runDepthLaneCycle, DEPTH_LANE_INTERVAL_MS);
};

const startAllLanes = () => {
    startFastLane();
    cron.schedule("*/5 9-15 * * 1-5", runSlowLane, { timezone: "Asia/Kolkata" });
    laneStatus.slowLane = "scheduled every 5 min during market hours";
    startDepthLane();
    laneStatus.depthLane = "scheduled every 15s, active only in TURBO/HIGH mode";
    logger.info("LaneManager", "All lanes started: fast (WS), slow (5min cron), depth (15s interval)");
};

const stopAllLanes = () => {
    if (depthLaneTimer) clearInterval(depthLaneTimer);
    laneStatus.depthLane = "stopped";
};

const getLaneStatus = () => ({ ...laneStatus });

export { startAllLanes, stopAllLanes, getLaneStatus };
