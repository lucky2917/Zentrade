import { Router } from "express";
import redis from "../config/redis.js";
import { STOCKS } from "../config/stocks.js";
import logger from "../utils/logger.js";
import { getCandlesForRange } from "../services/fyers/fyersREST.js";
import { toFyersStockSymbol } from "../services/fyers/smartWall.js";

const router = Router();

const YAHOO_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

let yahooCrumbCache = null;

async function getYahooCrumb() {
    if (yahooCrumbCache && yahooCrumbCache.expiresAt > Date.now()) {
        return yahooCrumbCache;
    }

    const cookieRes = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": YAHOO_UA } });
    const cookie = (cookieRes.headers.getSetCookie?.() || [])
        .map((c) => c.split(";")[0])
        .join("; ");

    const crumbRes = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
        headers: { "User-Agent": YAHOO_UA, Cookie: cookie },
    });
    const crumb = await crumbRes.text();

    yahooCrumbCache = { cookie, crumb, expiresAt: Date.now() + 60 * 60 * 1000 };
    return yahooCrumbCache;
}

async function fetchYahooFundamentals(symbol) {
    const yahooSymbol = `${symbol}.NS`;
    const { cookie, crumb } = await getYahooCrumb();
    const modules = "defaultKeyStatistics,summaryDetail,assetProfile";
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`;

    const response = await fetch(url, { headers: { "User-Agent": YAHOO_UA, Cookie: cookie } });
    if (!response.ok) return null;

    const data = await response.json();
    const result = data.quoteSummary?.result?.[0];
    if (!result) return null;

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
        const data = await redis.get(`stock:${symbol.toUpperCase()}`);

        if (!data) {
            return res.status(404).json({ error: "Stock not found" });
        }

        const parsed = JSON.parse(data);
        res.json(parsed);
    } catch (err) {
        logger.error("StocksAPI", "Failed to fetch stock", { error: err.message });
        res.status(500).json({ error: "Failed to fetch stock" });
    }
});

router.get("/:symbol/details", async (req, res) => {
    try {
        const { symbol } = req.params;
        const cacheKey = `details:${symbol.toUpperCase()}`;
        const cached = await redis.get(cacheKey);

        if (cached) {
            return res.json(JSON.parse(cached));
        }

        const yahooSymbol = `${symbol.toUpperCase()}.NS`;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=5d`;

        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            },
        });

        if (!response.ok) {
            return res.status(502).json({ error: "Failed to fetch stock details" });
        }

        const data = await response.json();
        const meta = data.chart?.result?.[0]?.meta;
        const stockInfo = STOCKS.find((s) => s.symbol === symbol.toUpperCase());

        const priceData = await redis.get(`stock:${symbol.toUpperCase()}`);
        const livePrice = priceData ? JSON.parse(priceData) : {};

        const details = {
            symbol: symbol.toUpperCase(),
            companyName: stockInfo?.name || symbol,
            price: livePrice.price || meta?.regularMarketPrice || 0,
            change: livePrice.change || 0,
            changePercent: livePrice.changePercent || 0,
            open: livePrice.open || meta?.regularMarketOpen || 0,
            previousClose: livePrice.previousClose || meta?.chartPreviousClose || 0,
            dayHigh: livePrice.dayHigh || meta?.regularMarketDayHigh || 0,
            dayLow: livePrice.dayLow || meta?.regularMarketDayLow || 0,
            volume: livePrice.volume || meta?.regularMarketVolume || 0,
            marketCap: meta?.marketCap || null,
            peRatio: meta?.peRatio || null,
            dividendYield: meta?.dividendYield || null,
            sector: meta?.sector || null,
            industry: meta?.industry || null,
            fiftyTwoWeekHigh: meta?.fiftyTwoWeekHigh || null,
            fiftyTwoWeekLow: meta?.fiftyTwoWeekLow || null,
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
        const cacheKey = `fundamentals:${symbol.toUpperCase()}`;
        const cached = await redis.get(cacheKey);

        if (cached) {
            return res.json(JSON.parse(cached));
        }

        const yahooFund = await fetchYahooFundamentals(symbol.toUpperCase());
        if (!yahooFund) {
            return res.status(502).json({ error: "Failed to fetch fundamentals" });
        }

        const stockInfo = STOCKS.find((s) => s.symbol === symbol.toUpperCase());

        const fundamentals = {
            symbol: symbol.toUpperCase(),
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
        const cacheKey = `perf:${symbol.toUpperCase()}`;
        const cached = await redis.get(cacheKey);

        if (cached) {
            return res.json(JSON.parse(cached));
        }

        const priceData = await redis.get(`stock:${symbol.toUpperCase()}`);
        const live = priceData ? JSON.parse(priceData) : {};

        const fyersSymbol = toFyersStockSymbol(symbol.toUpperCase());
        const yearCandles = await getCandlesForRange(fyersSymbol, "1y");
        const performance = computePerformance(live, yearCandles);

        await redis.setex(cacheKey, 300, JSON.stringify(performance));
        res.json(performance);
    } catch (err) {
        logger.error("StocksAPI", "Failed to fetch performance", { error: err.message });
        res.status(500).json({ error: "Failed to fetch performance data" });
    }
});

router.get("/:symbol/full", async (req, res) => {
    try {
        const { symbol } = req.params;
        const upperSymbol = symbol.toUpperCase();
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

        if (!chartData && chartResult) {
            chartData = chartResult;
            await redis.setex(chartCacheKey, 600, JSON.stringify(chartData));
        }

        if (!performance && perfCandles) {
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
