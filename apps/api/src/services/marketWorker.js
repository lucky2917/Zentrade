import redis from "../config/redis.js";
import { STOCKS } from "../config/stocks.js";
import logger from "../utils/logger.js";
import { isMarketOpen } from "../utils/marketHours.js";
import { getQuotes } from "./fyers/fyersREST.js";
import { feedIsTrusted } from "./fyers/feedStatus.js";
import { isRestAllowed } from "./fyers/rateLimiter.js";
import { sanitiseTick, toFyersStockSymbol, FYERS_INDEX_SYMBOLS, INDICES } from "./fyers/smartWall.js";

const QUOTE_BATCH_SIZE = 50;
const SLOW_LANE_INTERVAL_MS = 5 * 60 * 1000;
const PRICE_CHANNEL = "price:update";

const flattenQuoteEntry = (entry) => ({ ...entry, ...entry.v });

const cacheQuoteEntries = async (entries, keyPrefix) => {
    const pipeline = redis.pipeline();
    let updated = 0;

    for (const entry of entries) {
        if (entry.s !== "ok" || !entry.v) continue;
        const sanitised = sanitiseTick(flattenQuoteEntry(entry), "rest");
        if (sanitised) {
            const payload = JSON.stringify(sanitised);
            pipeline.set(`${keyPrefix}:${sanitised.symbol}`, payload);
            pipeline.publish(PRICE_CHANNEL, payload);
            updated++;
        }
    }

    await pipeline.exec();
    return updated;
};

const fetchAndCacheStockPrices = async () => {
    // The websocket already streams every one of these. This is the
    // backstop for when it is not delivering, not a second feed.
    if (feedIsTrusted()) return;
    if (!isMarketOpen()) return;

    try {
        let updated = 0;

        for (let i = 0; i < STOCKS.length; i += QUOTE_BATCH_SIZE) {
            const batch = STOCKS.slice(i, i + QUOTE_BATCH_SIZE);

            const allowed = await isRestAllowed();
            if (!allowed) {
                logger.error("MarketWorker", "Stock price refresh aborted, REST budget exhausted");
                break;
            }

            const fyersSymbols = batch.map((stock) => toFyersStockSymbol(stock.symbol));
            const response = await getQuotes(fyersSymbols);

            if (!response || response.s !== "ok" || !Array.isArray(response.d)) continue;
            updated += await cacheQuoteEntries(response.d, "stock");
        }

        logger.market("MarketWorker", `Slow-lane refresh: updated ${updated}/${STOCKS.length} stock prices`);
    } catch (err) {
        logger.error("MarketWorker", "Stock price fetch failed", { error: err.message });
    }
};

const fetchAndCacheIndices = async () => {
    if (feedIsTrusted()) return;
    if (!isMarketOpen()) return;

    try {
        const allowed = await isRestAllowed();
        if (!allowed) {
            logger.error("MarketWorker", "Index refresh aborted, REST budget exhausted");
            return;
        }

        const fyersSymbols = INDICES.map((index) => FYERS_INDEX_SYMBOLS[index.symbol]).filter(Boolean);
        const response = await getQuotes(fyersSymbols);

        if (!response || response.s !== "ok" || !Array.isArray(response.d)) return;
        const updated = await cacheQuoteEntries(response.d, "index");

        logger.market("MarketWorker", `Slow-lane refresh: updated ${updated}/${INDICES.length} indices`);
    } catch (err) {
        logger.error("MarketWorker", "Index fetch failed", { error: err.message });
    }
};

let priceTimer = null;
let indexTimer = null;

const stopMarketWorker = () => {
    if (priceTimer) clearInterval(priceTimer);
    if (indexTimer) clearInterval(indexTimer);
    priceTimer = null;
    indexTimer = null;
};

const startMarketWorker = () => {
    if (priceTimer) return false;   // duplicate start is a no-op
    logger.info("MarketWorker", "Starting market data worker (fyers REST slow-lane backstop)");
    fetchAndCacheStockPrices();
    fetchAndCacheIndices();
    priceTimer = setInterval(fetchAndCacheStockPrices, SLOW_LANE_INTERVAL_MS);
    indexTimer = setInterval(fetchAndCacheIndices, SLOW_LANE_INTERVAL_MS);
    return true;
};

export { INDICES };
export { startMarketWorker, stopMarketWorker };
export default startMarketWorker;
