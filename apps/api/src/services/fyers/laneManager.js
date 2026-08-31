import cron from "node-cron";
import redis from "../../config/redis.js";
import logger from "../../utils/logger.js";
import { isMarketOpen } from "../../utils/marketHours.js";
import { getQuotes, getMarketDepth } from "./fyersREST.js";
import { sanitiseTick } from "./smartWall.js";
import { isRestAllowed, getCurrentMode } from "./rateLimiter.js";
import { feedIsTrusted } from "./feedStatus.js";
import { getCurrentTier1 } from "./symbolManager.js";
import { screenSymbol } from "../screener.js";
import { sendTradeAlert, passesAlertThreshold } from "../alertService.js";
import { analyseStock } from "../aiEngine.js";
import { ALL_SYMBOLS } from "../../config/watchlist.js";

const SLOW_LANE_BATCH_SIZE = 50;
// Derived from the declared budget rather than picked. DEPTH_BUDGET is 9,600
// calls a day; a session is roughly 375 minutes; the lane makes 20 calls a
// cycle. A 50-second cycle is 450 cycles a session, so 9,000 calls — inside
// the budget with room for a restart mid-session.
//
// At the previous 15 seconds it was 80 calls a minute, which spends a 9,600
// budget in two hours and then leaves nothing for quotes — the "request limit
// reached" that started this. The interval and the budget now agree, and a
// test fails if they stop agreeing.
const DEPTH_LANE_INTERVAL_MS = 50000;
const DEPTH_BATCH_SIZE = 10;
const DEPTH_INTER_BATCH_DELAY_MS = 2500;
const DEPTH_TTL = 10;
// Two failures in a row means the venue or the budget is refusing, not that
// this batch was unlucky. Continuing past that is a retry storm.
const MAX_CONSECUTIVE_FAILURES = 2;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let depthLaneTimer = null;
let depthLaneRunning = false;
const laneStatus = {
    slowLane: "not started",
    depthLane: "not started",
};

const toRootSymbol = (fyersSymbol) => fyersSymbol.replace(/^(NSE|BSE):/, "").replace(/-EQ$/, "");

const fetchAllQuotesInBatches = async (symbols) => {
    const results = [];
    let consecutiveFailures = 0;
    for (let i = 0; i < symbols.length; i += SLOW_LANE_BATCH_SIZE) {
        const batch = symbols.slice(i, i + SLOW_LANE_BATCH_SIZE);

        const allowed = await isRestAllowed();
        if (!allowed) {
            logger.error("LaneManager", "Slow lane aborted, REST budget exhausted");
            break;
        }

        const response = await getQuotes(batch);
        if (!response || response.s !== "ok" || !Array.isArray(response.d)) {
            // Grinding through twenty more batches after the venue has started
            // refusing is how a failure becomes a retry storm. Stop, and let
            // the next scheduled pass try again.
            consecutiveFailures += 1;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                logger.warn("LaneManager", "slow lane stopped early after repeated failures",
                            { batchesDone: i / SLOW_LANE_BATCH_SIZE });
                break;
            }
            continue;
        }

        consecutiveFailures = 0;
        results.push(...response.d);
    }
    return results;
};

const runSlowLane = async () => {
    if (!isMarketOpen()) return;
    // The websocket already carries every one of these symbols. Polling them
    // anyway is what exhausts the budget that makes this a useful backstop.
    if (feedIsTrusted()) {
        laneStatus.slowLane = "standing by (websocket healthy)";
        return;
    }

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

            const analysis = await analyseStock(sanitised.symbol, "lane:slow");
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
            const response = await getMarketDepth(fyersSymbol);
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
    cron.schedule("*/5 9-15 * * 1-5", runSlowLane, { timezone: "Asia/Kolkata" });
    laneStatus.slowLane = "scheduled every 5 min during market hours";
    startDepthLane();
    laneStatus.depthLane = "scheduled every 15s, active only in TURBO/HIGH mode";
    logger.info("LaneManager", "All lanes started: slow (5min cron), depth (15s interval)");
};

const stopAllLanes = () => {
    if (depthLaneTimer) clearInterval(depthLaneTimer);
    laneStatus.depthLane = "stopped";
};

const getLaneStatus = () => ({ ...laneStatus });

export { startAllLanes, stopAllLanes, getLaneStatus };
