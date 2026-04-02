import { Router } from "express";
import redis from "../config/redis.js";
import { STOCKS } from "../config/stocks.js";
import logger from "../utils/logger.js";

const router = Router();

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
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=5d`;

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

        const yahooSymbol = `${symbol.toUpperCase()}.NS`;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=1y`;

        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
            },
        });

        if (!response.ok) {
            return res.status(502).json({ error: "Failed to fetch fundamentals" });
        }

        const data = await response.json();
        const meta = data.chart?.result?.[0]?.meta;
        const stockInfo = STOCKS.find((s) => s.symbol === symbol.toUpperCase());

        const fundamentals = {
            symbol: symbol.toUpperCase(),
            companyName: stockInfo?.name || symbol,
            marketCap: meta?.marketCap || null,
            peRatio: meta?.peRatio || null,
            pbRatio: meta?.pbRatio || null,
            roe: null,
            eps: meta?.epsTrailingTwelveMonths || null,
            dividendYield: meta?.dividendYield || null,
            debtToEquity: null,
            bookValue: meta?.bookValue || null,
            fiftyTwoWeekHigh: meta?.fiftyTwoWeekHigh || null,
            fiftyTwoWeekLow: meta?.fiftyTwoWeekLow || null,
            avgVolume: meta?.averageDailyVolume3Month || null,
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

        const yahooSymbol = `${symbol.toUpperCase()}.NS`;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=1y`;

        let meta = {};
        try {
            const response = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
                },
            });
            if (response.ok) {
                const data = await response.json();
                meta = data.chart?.result?.[0]?.meta || {};
            }
        } catch {
            meta = {};
        }

        const performance = {
            open: live.open || meta.regularMarketOpen || 0,
            previousClose: live.previousClose || meta.chartPreviousClose || 0,
            dayHigh: live.dayHigh || meta.regularMarketDayHigh || 0,
            dayLow: live.dayLow || meta.regularMarketDayLow || 0,
            fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
            fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
            volume: live.volume || meta.regularMarketVolume || 0,
        };

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

        const yahooSymbol = `${upperSymbol}.NS`;

        const chartRange = range;
        const RANGE_CONFIG = {
            "1d": { interval: "1m", period: "1d" },
            "5d": { interval: "5m", period: "5d" },
            "1mo": { interval: "1h", period: "1mo" },
            "3mo": { interval: "1d", period: "3mo" },
            "1y": { interval: "1d", period: "1y" },
            "5y": { interval: "1wk", period: "5y" },
        };
        const config = RANGE_CONFIG[chartRange] || RANGE_CONFIG["1d"];

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

        const needsYahoo = !chartData || !performance || !fundamentals;

        if (needsYahoo) {
            const fetchPromises = [];

            if (!chartData) {
                fetchPromises.push(
                    fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${config.interval}&range=${config.period}`, {
                        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
                    }).then((r) => r.ok ? r.json() : null).catch(() => null)
                );
            } else {
                fetchPromises.push(Promise.resolve(null));
            }

            if (!performance || !fundamentals) {
                fetchPromises.push(
                    fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=1d&range=1y`, {
                        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
                    }).then((r) => r.ok ? r.json() : null).catch(() => null)
                );
            } else {
                fetchPromises.push(Promise.resolve(null));
            }

            const [chartResponse, yearResponse] = await Promise.all(fetchPromises);

            if (chartResponse && !chartData) {
                const result = chartResponse.chart?.result?.[0];
                if (result && result.timestamp) {
                    const timestamps = result.timestamp;
                    const ohlcv = result.indicators.quote[0];
                    chartData = timestamps
                        .map((t, i) => ({
                            time: t,
                            open: ohlcv.open[i],
                            high: ohlcv.high[i],
                            low: ohlcv.low[i],
                            close: ohlcv.close[i],
                            volume: ohlcv.volume[i],
                        }))
                        .filter((c) => c.open != null && c.close != null);

                    await redis.setex(chartCacheKey, 600, JSON.stringify(chartData));
                }
            }

            if (yearResponse) {
                const meta = yearResponse.chart?.result?.[0]?.meta || {};

                if (!performance) {
                    performance = {
                        open: live.open || meta.regularMarketOpen || 0,
                        previousClose: live.previousClose || meta.chartPreviousClose || 0,
                        dayHigh: live.dayHigh || meta.regularMarketDayHigh || 0,
                        dayLow: live.dayLow || meta.regularMarketDayLow || 0,
                        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
                        fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
                        volume: live.volume || meta.regularMarketVolume || 0,
                    };
                    await redis.setex(perfCacheKey, 300, JSON.stringify(performance));
                }

                if (!fundamentals) {
                    fundamentals = {
                        marketCap: meta.marketCap || null,
                        peRatio: meta.peRatio || null,
                        pbRatio: meta.pbRatio || null,
                        eps: meta.epsTrailingTwelveMonths || null,
                        dividendYield: meta.dividendYield || null,
                        bookValue: meta.bookValue || null,
                        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || null,
                        fiftyTwoWeekLow: meta.fiftyTwoWeekLow || null,
                    };
                    await redis.setex(fundCacheKey, 3600, JSON.stringify(fundamentals));
                }
            }
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

/*
 * the big stocks route file. has endpoints to get all stocks,
 * a single stock, its details, fundamentals, performance stats,
 * and the /full endpoint which bundles chart + performance +
 * fundamentals into one call (thats what the StockDetail page
 * uses so it doesnt have to make three separate requests).
 * mounted at /api/stocks in index.js.
 */
