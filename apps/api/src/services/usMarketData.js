import { startYahooCooldown, YAHOO_UA, FETCH_TIMEOUT_MS } from "./yahooCrumb.js";
import redis from "../config/redis.js";
import logger from "../utils/logger.js";
import { US_STOCKS } from "../config/usStocks.js";

const SYMBOL_RE = /^[A-Z]{1,10}$/;

/**
 * US market data. Quotes come from Finnhub (a real API key, not a scraped
 * endpoint), charts still come from Yahoo Finance directly -- no dependency
 * on us_agent or any Python process either way.
 *
 * Quotes moved off Yahoo after confirmed, sustained production 429s on
 * Yahoo's crumb/quote endpoints (Render's IP getting rate-limited, not a
 * code bug -- two genuine retries a few seconds apart both failed). Finnhub
 * has no free batch endpoint, so this fetches each symbol individually;
 * QUOTE_CACHE_TTL is sized to stay well under Finnhub's free-tier 60
 * calls/minute even for the full US_STOCKS universe in one cache refresh.
 *
 * Finnhub's free tier does not include historical candles, so charts still
 * go through Yahoo and are still subject to the same rate limiting.
 *
 * No true real-time push feed exists for free US data, so "live" here
 * means short-TTL cached polling, refreshed on each client request that
 * finds a stale/missing cache entry -- same pattern as the Indian chart
 * cache, just without a WebSocket layer behind it.
 */

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || "";
const FINNHUB_QUOTE_URL = "https://finnhub.io/api/v1/quote";

const QUOTE_CACHE_TTL = 60;
const CHART_CACHE_TTL = { "1d": 60, "5d": 300, "1mo": 600, "3mo": 600, "1y": 600, "5y": 600 };
const VALID_RANGES = Object.keys(CHART_CACHE_TTL);
const RANGE_TO_INTERVAL = { "1d": "5m", "5d": "15m", "1mo": "1d", "3mo": "1d", "1y": "1wk", "5y": "1mo" };

const RATE_LIMIT_RETRY_DELAY_MS = 4000;

// Mirrors trader_loop.py's is_market_open and the frontend's
// useUsMarketHours.js -- same Mon-Fri 9:30-16:00 ET window, duplicated
// deliberately (each context already has its own small copy, not a shared
// module) rather than introduced as a new cross-language dependency.
const isUsMarketOpenNow = () => {
    const nowEt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const day = nowEt.getDay();
    const minutes = nowEt.getHours() * 60 + nowEt.getMinutes();
    return day >= 1 && day <= 5 && minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
};

const fetchOneQuote = async (symbol) => {
    const res = await fetch(`${FINNHUB_QUOTE_URL}?symbol=${symbol}&token=${FINNHUB_API_KEY}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status === 429) {
        const err = new Error(`Finnhub quote request failed (429) for ${symbol}`);
        err.rateLimited = true;
        throw err;
    }
    if (!res.ok) throw new Error(`Finnhub quote request failed (${res.status}) for ${symbol}`);

    const q = await res.json();
    // c === 0 with no other fields populated is Finnhub's shape for "no
    // data for this symbol" (bad ticker, not yet covered), not a real zero
    // price -- treat it the same as a missing symbol rather than showing $0.
    if (!q || q.c === undefined || q.c === null || (q.c === 0 && q.pc === 0)) return null;

    return {
        symbol,
        regularMarketPrice: q.c,
        regularMarketChange: q.d ?? null,
        regularMarketChangePercent: q.dp ?? null,
        regularMarketDayHigh: q.h ?? null,
        regularMarketDayLow: q.l ?? null,
        fiftyTwoWeekHigh: null,
        fiftyTwoWeekLow: null,
        marketCap: null,
        marketState: isUsMarketOpenNow() ? "REGULAR" : "CLOSED",
    };
};

const fetchOneQuoteWithRetry = async (symbol) => {
    try {
        return await fetchOneQuote(symbol);
    } catch (err) {
        if (!err.rateLimited) throw err;
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS));
        return fetchOneQuote(symbol);
    }
};

const fetchQuotes = async (symbols) => {
    if (!FINNHUB_API_KEY) throw new Error("FINNHUB_API_KEY is not configured");
    const settled = await Promise.allSettled(symbols.map(fetchOneQuoteWithRetry));
    const results = [];
    settled.forEach((outcome, i) => {
        if (outcome.status === "fulfilled" && outcome.value) {
            results.push(outcome.value);
        } else if (outcome.status === "rejected") {
            logger.warn("UsMarketData", "quote fetch failed for symbol", { symbol: symbols[i], error: outcome.reason?.message });
        }
    });
    return results;
};

// Dedupes concurrent identical requests (e.g. every open tab's poll firing
// in the same instant right after the shared cache TTL rolls over) so they
// share one Finnhub fetch instead of each starting their own.
const quotesInFlight = new Map();

export const getUsQuotes = async (symbols) => {
    const wanted = symbols.filter((s) => US_STOCKS.some((u) => u.symbol === s));
    if (wanted.length === 0) return [];

    const cacheKeys = wanted.map((s) => `us:quote:${s}`);
    const cached = await redis.mget(cacheKeys);

    const missing = wanted.filter((_, i) => !cached[i]);
    let fresh = [];
    if (missing.length > 0) {
        const dedupeKey = missing.slice().sort().join(",");
        let inFlight = quotesInFlight.get(dedupeKey);
        if (!inFlight) {
            inFlight = fetchQuotes(missing)
                .then(async (result) => {
                    await Promise.all(
                        result.map((q) =>
                            q.symbol ? redis.setex(`us:quote:${q.symbol}`, QUOTE_CACHE_TTL, JSON.stringify(q)) : null
                        )
                    );
                    return result;
                })
                .finally(() => quotesInFlight.delete(dedupeKey));
            quotesInFlight.set(dedupeKey, inFlight);
        }
        try {
            fresh = await inFlight;
        } catch (err) {
            logger.error("UsMarketData", "quote fetch failed", { error: err.message, symbols: missing });
        }
    }

    const freshBySymbol = new Map(fresh.map((q) => [q.symbol, q]));
    return wanted.map((symbol, i) => {
        if (cached[i]) return JSON.parse(cached[i]);
        return freshBySymbol.get(symbol) || null;
    }).filter(Boolean);
};

const chartInFlight = new Map();

export const getUsChart = async (symbol, range) => {
    if (!SYMBOL_RE.test(symbol)) throw new Error(`invalid symbol: ${symbol}`);
    const chartRange = VALID_RANGES.includes(range) ? range : "1d";
    const cacheKey = `us:chart:${symbol}:${chartRange}`;
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    let inFlight = chartInFlight.get(cacheKey);
    if (!inFlight) {
        inFlight = fetchChart(symbol, chartRange).finally(() => chartInFlight.delete(cacheKey));
        chartInFlight.set(cacheKey, inFlight);
    }
    return inFlight;
};

async function attemptFetchChart(symbol, chartRange) {
    const interval = RANGE_TO_INTERVAL[chartRange];
    const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${chartRange}&interval=${interval}`,
        { headers: { "User-Agent": YAHOO_UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    if (res.status === 429) {
        const err = new Error(`Yahoo chart request failed (429)`);
        err.rateLimited = true;
        throw err;
    }
    if (!res.ok) {
        // Unlike fetchQuotes, this doesn't need a crumb, so a failure here
        // isn't crumb staleness -- it's Yahoo rejecting/rate-limiting this
        // endpoint outright. Back off the same way, otherwise a persistently
        // failing chart gets retried on every page load/range click with no
        // cooldown at all.
        startYahooCooldown();
        throw new Error(`Yahoo chart request failed (${res.status})`);
    }
    return res.json();
}

async function fetchChart(symbol, chartRange) {
    const cacheKey = `us:chart:${symbol}:${chartRange}`;
    let body;
    try {
        body = await attemptFetchChart(symbol, chartRange);
    } catch (err) {
        if (!err.rateLimited) throw err;
        logger.warn("UsMarketData", "chart fetch rate limited, retrying once", { symbol, chartRange });
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_RETRY_DELAY_MS));
        try {
            body = await attemptFetchChart(symbol, chartRange);
        } catch (retryErr) {
            startYahooCooldown();
            throw retryErr;
        }
    }

    const result = body?.chart?.result?.[0];
    if (!result?.timestamp) return [];

    const { timestamp, indicators } = result;
    const quote = indicators?.quote?.[0] || {};
    const candles = timestamp
        .map((time, i) => ({
            time,
            open: quote.open?.[i],
            high: quote.high?.[i],
            low: quote.low?.[i],
            close: quote.close?.[i],
            volume: quote.volume?.[i],
        }))
        .filter((c) => c.open != null && c.close != null && c.high != null && c.low != null);

    if (candles.length > 0) {
        await redis.setex(cacheKey, CHART_CACHE_TTL[chartRange], JSON.stringify(candles));
    }
    return candles;
}

export const listUsStocks = () => US_STOCKS;

export { VALID_RANGES };
