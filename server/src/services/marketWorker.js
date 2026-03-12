import redis from "../config/redis.js";
import { STOCKS } from "../config/stocks.js";
import logger from "../utils/logger.js";

const INDICES = [
    { symbol: "NIFTY50", yahooSymbol: "^NSEI", name: "NIFTY 50" },
    { symbol: "SENSEX", yahooSymbol: "^BSESN", name: "SENSEX" },
    { symbol: "BANKNIFTY", yahooSymbol: "^NSEBANK", name: "BANK NIFTY" },
];

const fetchChartMeta = async (yahooSymbol) => {
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`;
        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            },
        });

        if (!response.ok) return null;

        const data = await response.json();
        const result = data.chart?.result?.[0];
        if (!result) return null;

        const meta = result.meta;
        if (!meta || !meta.regularMarketPrice) return null;

        const indicators = result.indicators?.quote?.[0];
        let dayHigh = meta.regularMarketDayHigh || 0;
        let dayLow = meta.regularMarketDayLow || 0;
        let volume = meta.regularMarketVolume || 0;

        if (indicators && indicators.high) {
            const highs = indicators.high.filter((v) => v != null);
            const lows = indicators.low.filter((v) => v != null);
            if (highs.length > 0 && dayHigh === 0) dayHigh = Math.max(...highs);
            if (lows.length > 0 && dayLow === 0) dayLow = Math.min(...lows);
        }

        return {
            price: meta.regularMarketPrice,
            previousClose: meta.chartPreviousClose || meta.previousClose || 0,
            open: meta.regularMarketOpen || 0,
            dayHigh,
            dayLow,
            volume,
            marketState: meta.marketState || "CLOSED",
        };
    } catch {
        return null;
    }
};

const fetchAndCacheStockPrices = async () => {
    try {
        const batchSize = 5;
        const pipeline = redis.pipeline();
        let updated = 0;

        for (let i = 0; i < STOCKS.length; i += batchSize) {
            const batch = STOCKS.slice(i, i + batchSize);
            const results = await Promise.all(
                batch.map(async (stock) => {
                    const meta = await fetchChartMeta(stock.yahooSymbol);
                    if (!meta) return null;

                    const change = meta.previousClose > 0
                        ? Math.round(((meta.price - meta.previousClose) / meta.previousClose) * 10000) / 100
                        : 0;

                    return {
                        symbol: stock.symbol,
                        name: stock.name,
                        price: meta.price,
                        change: meta.price - meta.previousClose,
                        changePercent: change,
                        open: meta.open,
                        previousClose: meta.previousClose,
                        dayHigh: meta.dayHigh,
                        dayLow: meta.dayLow,
                        volume: meta.volume,
                        marketState: meta.marketState,
                        timestamp: Date.now(),
                    };
                })
            );

            for (const result of results) {
                if (result) {
                    pipeline.set(`stock:${result.symbol}`, JSON.stringify(result));
                    updated++;
                }
            }
        }

        await pipeline.exec();
        logger.market("MarketWorker", `Updated ${updated}/${STOCKS.length} stock prices`);
    } catch (err) {
        logger.error("MarketWorker", "Stock price fetch failed", { error: err.message });
    }
};

const fetchAndCacheIndices = async () => {
    try {
        const pipeline = redis.pipeline();
        let updated = 0;

        for (const index of INDICES) {
            const meta = await fetchChartMeta(index.yahooSymbol);
            if (!meta) continue;

            const change = meta.previousClose > 0
                ? Math.round(((meta.price - meta.previousClose) / meta.previousClose) * 10000) / 100
                : 0;

            const data = {
                symbol: index.symbol,
                name: index.name,
                price: meta.price,
                change: meta.price - meta.previousClose,
                changePercent: change,
                timestamp: Date.now(),
            };

            pipeline.set(`index:${index.symbol}`, JSON.stringify(data));
            updated++;
        }

        await pipeline.exec();
        logger.market("MarketWorker", `Updated ${updated}/${INDICES.length} indices`);
    } catch (err) {
        logger.error("MarketWorker", "Index fetch failed", { error: err.message });
    }
};

const startMarketWorker = () => {
    logger.info("MarketWorker", "Starting market data worker");
    fetchAndCacheStockPrices();
    fetchAndCacheIndices();
    setInterval(fetchAndCacheStockPrices, 5000);
    setInterval(fetchAndCacheIndices, 10000);
};

export { INDICES };
export default startMarketWorker;
