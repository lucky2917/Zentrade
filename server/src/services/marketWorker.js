import redis from "../config/redis.js";
import { STOCKS } from "../config/stocks.js";

const fetchStockPrice = async (stock) => {
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${stock.yahooSymbol}?interval=1d&range=1d`;
        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            },
        });

        if (!response.ok) return null;

        const data = await response.json();
        const meta = data.chart?.result?.[0]?.meta;
        if (!meta || !meta.regularMarketPrice) return null;

        const currentPrice = meta.regularMarketPrice;
        const previousClose = meta.chartPreviousClose || currentPrice;
        const change = ((currentPrice - previousClose) / previousClose) * 100;

        return {
            symbol: stock.symbol,
            price: currentPrice,
            change: Math.round(change * 100) / 100,
            timestamp: Date.now(),
        };
    } catch {
        return null;
    }
};

const fetchAndCachePrices = async () => {
    try {
        const batchSize = 5;
        const pipeline = redis.pipeline();

        for (let i = 0; i < STOCKS.length; i += batchSize) {
            const batch = STOCKS.slice(i, i + batchSize);
            const results = await Promise.all(batch.map(fetchStockPrice));

            for (const result of results) {
                if (result) {
                    pipeline.set(`stock:${result.symbol}`, JSON.stringify(result));
                }
            }
        }

        await pipeline.exec();
    } catch (err) {
        console.error("Market worker error:", err.message);
    }
};

const startMarketWorker = () => {
    fetchAndCachePrices();
    setInterval(fetchAndCachePrices, 5000);
};

export default startMarketWorker;
