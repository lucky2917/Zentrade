import { Router } from "express";
import redis from "../config/redis.js";
import { STOCKS, STOCK_MAP } from "../config/stocks.js";
import logger from "../utils/logger.js";
import { getCandlesForRange } from "../services/fyers/fyersREST.js";
import { toFyersStockSymbol } from "../services/fyers/smartWall.js";
import { getYahooCrumb, YAHOO_UA } from "../services/yahooCrumb.js";

const router = Router();

async function fetchYahooFundamentals(symbol) {
    const yahooSymbol = `${symbol}.NS`;
    const { cookie, crumb } = await getYahooCrumb();
    const modules = "defaultKeyStatistics,summaryDetail,assetProfile";
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;

    const response = await fetch(url, { headers: { "User-Agent": YAHOO_UA, Cookie: cookie } });
    if (!response.ok) {
        logger.warn("StocksAPI", "Yahoo fundamentals request failed", {
            symbol,
            status: response.status,
            body: (await response.text()).slice(0, 300),
        });
        return null;
    }

    const data = await response.json();
    const result = data.quoteSummary?.result?.[0];
    if (!result) {
        logger.warn("StocksAPI", "Yahoo fundamentals response had no result", { symbol });
        return null;
    }

    const sd = result.summaryDetail || {};
    const ks = result.defaultKeyStatistics || {};
    const ap = result.assetProfile || {};
    const raw = (field) => (field && typeof field === "object" ? field.raw ?? null : field ?? null);

    return {
        marketCap: raw(sd.marketCap),
        peRatio: raw(sd.trailingPE),
        pbRatio: raw(ks.priceToBook),
        eps: raw(ks.trailingEps),
        dividendYield: raw(sd.dividendYield) != null ? raw(sd.dividendYield) * 100 : null,
        bookValue: raw(ks.bookValue),
        fiftyTwoWeekHigh: raw(sd.fiftyTwoWeekHigh),
        fiftyTwoWeekLow: raw(sd.fiftyTwoWeekLow),
        avgVolume: raw(sd.averageVolume),
        sector: ap.sector || null,
        industry: ap.industry || null,
    };
}

function computePerformance(live, yearCandles) {
    const highs = yearCandles.map((c) => c.high).filter((v) => v != null);
    const lows = yearCandles.map((c) => c.low).filter((v) => v != null);
    const latest = yearCandles[yearCandles.length - 1];
    const prior = yearCandles[yearCandles.length - 2];

    return {
        open: live.open || latest?.open || 0,
        previousClose: live.previousClose || prior?.close || 0,
        dayHigh: live.dayHigh || latest?.high || 0,
        dayLow: live.dayLow || latest?.low || 0,
        fiftyTwoWeekHigh: highs.length ? Math.max(...highs) : null,
        fiftyTwoWeekLow: lows.length ? Math.min(...lows) : null,
        volume: live.volume || latest?.volume || 0,
    };
}

router.get("/", async (req, res) => {
    try {
        const pipeline = redis.pipeline();
        STOCKS.forEach((stock) => pipeline.get(`stock:${stock.symbol}`));
        const results = await pipeline.exec();

        const stocks = STOCKS.map((stock, i) => {
            const data = results[i][1] ? JSON.parse(results[i][1]) : null;
            return {
                symbol: stock.symbol,
                name: stock.name,
                price: data?.price ?? null,
                change: data?.change ?? null,
                changePercent: data?.changePercent ?? null,
                open: data?.open ?? null,
                previousClose: data?.previousClose ?? null,
                dayHigh: data?.dayHigh ?? null,
                dayLow: data?.dayLow ?? null,
                volume: data?.volume ?? null,
                marketState: data?.marketState ?? null,
                timestamp: data?.timestamp ?? null,
            };
        });

        res.json(stocks);
    } catch (err) {
        logger.error("StocksAPI", "Failed to fetch stocks", { error: err.message });
        res.status(500).json({ error: "Failed to fetch stocks" });
    }
});

router.get("/:symbol", async (req, res) => {
    try {
        const { symbol } = req.params;
        const upper = symbol.toUpperCase();
        if (!STOCK_MAP.has(upper)) return res.status(404).json({ error: "Unknown symbol" });
        const data = await redis.get(`stock:${upper}`);

        if (!data) return res.status(404).json({ error: "Stock not found" });
        res.json(JSON.parse(data));
    } catch (err) {
        logger.error("StocksAPI", "Failed to fetch stock", { error: err.message });
        res.status(500).json({ error: "Failed to fetch stock" });
    }
});

router.get("/:symbol/details", async (req, res) => {
    try {
        const { symbol } = req.params;
        const upperSymbol = symbol.toUpperCase();
        if (!STOCK_MAP.has(upperSymbol)) return res.status(404).json({ error: "Unknown symbol" });
        const cacheKey = `details:${upperSymbol}`;
        const cached = await redis.get(cacheKey);
        if (cached) return res.json(JSON.parse(cached));

        const yahooSymbol = `${upperSymbol}.NS`;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d`;

        const [response, fundamentals] = await Promise.all([
            fetch(url, {
                headers: { "User-Agent": YAHOO_UA },
            }),
            fetchYahooFundamentals(upperSymbol).catch(() => null),
        ]);

        if (!response.ok) {
            return res.status(502).json({ error: "Failed to fetch stock details" });
        }

        const data = await response.json();
        const meta = data.chart?.result?.[0]?.meta;
        const stockInfo = STOCKS.find((s) => s.symbol === upperSymbol);

        const priceData = await redis.get(`stock:${upperSymbol}`);
        const livePrice = priceData ? JSON.parse(priceData) : {};

        const details = {
            symbol: upperSymbol,
            companyName: stockInfo?.name || symbol,
            price: livePrice.price || meta?.regularMarketPrice || 0,
            change: livePrice.change || 0,
            changePercent: livePrice.changePercent || 0,
            open: livePrice.open || meta?.regularMarketOpen || 0,
            previousClose: livePrice.previousClose || meta?.chartPreviousClose || 0,
            dayHigh: livePrice.dayHigh || meta?.regularMarketDayHigh || 0,
            dayLow: livePrice.dayLow || meta?.regularMarketDayLow || 0,
            volume: livePrice.volume || meta?.regularMarketVolume || 0,
            marketCap: fundamentals?.marketCap ?? null,
            peRatio: fundamentals?.peRatio ?? null,
            dividendYield: fundamentals?.dividendYield ?? null,
            sector: fundamentals?.sector ?? null,
            industry: fundamentals?.industry ?? null,
            fiftyTwoWeekHigh: fundamentals?.fiftyTwoWeekHigh ?? meta?.fiftyTwoWeekHigh ?? null,
            fiftyTwoWeekLow: fundamentals?.fiftyTwoWeekLow ?? meta?.fiftyTwoWeekLow ?? null,
            exchangeName: meta?.exchangeName || "NSE",
            currency: meta?.currency || "INR",
        };

        await redis.setex(cacheKey, 3600, JSON.stringify(details));

        res.json(details);
    } catch (err) {
        logger.error("StocksAPI", "Failed to fetch stock details", { error: err.message });
        res.status(500).json({ error: "Failed to fetch stock details" });
    }
});

router.get("/:symbol/fundamentals", async (req, res) => {
    try {
        const { symbol } = req.params;
        const upper = symbol.toUpperCase();
        if (!STOCK_MAP.has(upper)) return res.status(404).json({ error: "Unknown symbol" });
        const cacheKey = `fundamentals:${upper}`;
        const cached = await redis.get(cacheKey);
        if (cached) return res.json(JSON.parse(cached));

        // M3: Yahoo is a scraping dependency that can break silently — return what we have
        const yahooFund = await fetchYahooFundamentals(upper).catch((err) => {
            logger.warn("StocksAPI", "Yahoo fundamentals unavailable, returning empty", { symbol: upper, error: err.message });
            return null;
        });
        if (!yahooFund) return res.json({ symbol: upper, companyName: stockInfo?.name || upper });

        const stockInfo = STOCKS.find((s) => s.symbol === upper);

        const fundamentals = {
            symbol: upper,
            companyName: stockInfo?.name || symbol,
            ...yahooFund,
            roe: null,
            debtToEquity: null,
        };

        await redis.setex(cacheKey, 3600, JSON.stringify(fundamentals));

        res.json(fundamentals);
    } catch (err) {
        logger.error("StocksAPI", "Failed to fetch fundamentals", { error: err.message });
        res.status(500).json({ error: "Failed to fetch fundamentals" });
    }
});

router.get("/:symbol/performance", async (req, res) => {
    try {
        const { symbol } = req.params;
        const upper = symbol.toUpperCase();
        if (!STOCK_MAP.has(upper)) return res.status(404).json({ error: "Unknown symbol" });
        const cacheKey = `perf:${upper}`;
        const cached = await redis.get(cacheKey);
        if (cached) return res.json(JSON.parse(cached));

        const priceData = await redis.get(`stock:${upper}`);
        const live = priceData ? JSON.parse(priceData) : {};

        const fyersSymbol = toFyersStockSymbol(upper);
        const yearCandles = await getCandlesForRange(fyersSymbol, "1y");
        const perf = computePerformance(live, yearCandles);

        await redis.setex(cacheKey, 300, JSON.stringify(perf));
        res.json(perf);
    } catch (err) {
        logger.error("StocksAPI", "Failed to fetch performance", { error: err.message });
        res.status(500).json({ error: "Failed to fetch performance data" });
    }
});

router.get("/:symbol/full", async (req, res) => {
    try {
        const { symbol } = req.params;
        const upperSymbol = symbol.toUpperCase();
        if (!STOCK_MAP.has(upperSymbol)) return res.status(404).json({ error: "Unknown symbol" });
        const range = req.query.range || "1d";

        const priceData = await redis.get(`stock:${upperSymbol}`);
        const live = priceData ? JSON.parse(priceData) : {};
        const stockInfo = STOCKS.find((s) => s.symbol === upperSymbol);

        const VALID_RANGES = ["1d", "5d", "1mo", "3mo", "1y", "5y"];
        const chartRange = VALID_RANGES.includes(range) ? range : "1d";

        const chartCacheKey = `chart:${upperSymbol}:${chartRange}`;
        const perfCacheKey = `perf:${upperSymbol}`;
        const fundCacheKey = `fundamentals:${upperSymbol}`;

        const [cachedChart, cachedPerf, cachedFund] = await Promise.all([
            redis.get(chartCacheKey),
            redis.get(perfCacheKey),
            redis.get(fundCacheKey),
        ]);

        let chartData = cachedChart ? JSON.parse(cachedChart) : null;
        let performance = cachedPerf ? JSON.parse(cachedPerf) : null;
        let fundamentals = cachedFund ? JSON.parse(cachedFund) : null;

        const fyersSymbol = toFyersStockSymbol(upperSymbol);

        const [chartResult, perfCandles, fundResult] = await Promise.all([
            chartData ? Promise.resolve(null) : getCandlesForRange(fyersSymbol, chartRange).catch(() => null),
            performance ? Promise.resolve(null) : getCandlesForRange(fyersSymbol, "1y").catch(() => null),
            fundamentals ? Promise.resolve(null) : fetchYahooFundamentals(upperSymbol).catch(() => null),
        ]);

        if (!chartData && chartResult?.length > 0) {
            chartData = chartResult;
            await redis.setex(chartCacheKey, 600, JSON.stringify(chartData));
        }

        if (!performance && perfCandles?.length > 0) {
            performance = computePerformance(live, perfCandles);
            await redis.setex(perfCacheKey, 300, JSON.stringify(performance));
        }

        if (!fundamentals && fundResult) {
            fundamentals = fundResult;
            await redis.setex(fundCacheKey, 3600, JSON.stringify(fundamentals));
        }

        res.json({
            symbol: upperSymbol,
            companyName: stockInfo?.name || upperSymbol,
            price: live.price || 0,
            change: live.change || 0,
            changePercent: live.changePercent || 0,
            marketState: live.marketState || "CLOSED",
            performance: performance || {},
            fundamentals: fundamentals || {},
            chart: chartData || [],
        });
    } catch (err) {
        logger.error("StocksAPI", "Failed to fetch full stock data", { error: err.message });
        res.status(500).json({ error: "Failed to fetch stock data" });
    }
});

export default router;
