import redis from "../config/redis.js";
import { STOCKS } from "../config/stocks.js";
import logger from "../utils/logger.js";
import { isMarketOpen } from "../utils/marketHours.js";
import { getQuotes } from "./fyers/fyersREST.js";
import { sanitiseTick, toFyersStockSymbol, FYERS_INDEX_SYMBOLS, INDICES } from "./fyers/smartWall.js";

const QUOTE_BATCH_SIZE = 50;
const SLOW_LANE_INTERVAL_MS = 5 * 60 * 1000;

const flattenQuoteEntry = (entry) => ({ ...entry, ...entry.v });

const cacheQuoteEntries = async (entries, keyPrefix) => {
    const pipeline = redis.pipeline();
    let updated = 0;

    for (const entry of entries) {
        if (entry.s !== "ok" || !entry.v) continue;
        const sanitised = sanitiseTick(flattenQuoteEntry(entry));
        if (sanitised) {
            pipeline.set(`${keyPrefix}:${sanitised.symbol}`, JSON.stringify(sanitised));
            updated++;
        }
    }

    await pipeline.exec();
    return updated;
};

const fetchAndCacheStockPrices = async () => {
    if (!isMarketOpen()) return;

    try {
        let updated = 0;

        for (let i = 0; i < STOCKS.length; i += QUOTE_BATCH_SIZE) {
            const batch = STOCKS.slice(i, i + QUOTE_BATCH_SIZE);
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
    if (!isMarketOpen()) return;

    try {
        const fyersSymbols = INDICES.map((index) => FYERS_INDEX_SYMBOLS[index.symbol]).filter(Boolean);
        const response = await getQuotes(fyersSymbols);

        if (!response || response.s !== "ok" || !Array.isArray(response.d)) return;
        const updated = await cacheQuoteEntries(response.d, "index");

        logger.market("MarketWorker", `Slow-lane refresh: updated ${updated}/${INDICES.length} indices`);
    } catch (err) {
        logger.error("MarketWorker", "Index fetch failed", { error: err.message });
    }
};

const startMarketWorker = () => {
    logger.info("MarketWorker", "Starting market data worker (fyers REST slow-lane backstop)");
    fetchAndCacheStockPrices();
    fetchAndCacheIndices();
    setInterval(fetchAndCacheStockPrices, SLOW_LANE_INTERVAL_MS);
    setInterval(fetchAndCacheIndices, SLOW_LANE_INTERVAL_MS);
};

export { INDICES };
export default startMarketWorker;
