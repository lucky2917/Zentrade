import { getYahooCrumb, invalidateYahooCrumb, startYahooCooldown, YAHOO_UA, FETCH_TIMEOUT_MS } from "./yahooCrumb.js";
import redis from "../config/redis.js";
import logger from "../utils/logger.js";
import { US_STOCKS } from "../config/usStocks.js";

const SYMBOL_RE = /^[A-Z]{1,10}$/;

/**
 * US market data, direct from Yahoo Finance -- no dependency on us_agent
 * or any Python process. Reuses the existing yahooCrumb service (already
 * battle-tested for Indian macro/index context) rather than rebuilding
 * crumb/cookie handling.
 *
 * No true real-time push feed exists for free US data, so "live" here
 * means short-TTL cached polling, refreshed on each client request that
 * finds a stale/missing cache entry -- same pattern as the Indian chart
 * cache, just without a WebSocket layer behind it.
 */

const QUOTE_CACHE_TTL = 15;
const CHART_CACHE_TTL = { "1d": 60, "5d": 300, "1mo": 600, "3mo": 600, "1y": 600, "5y": 600 };
const VALID_RANGES = Object.keys(CHART_CACHE_TTL);
const RANGE_TO_INTERVAL = { "1d": "5m", "5d": "15m", "1mo": "1d", "3mo": "1d", "1y": "1wk", "5y": "1mo" };

// A crumb that Yahoo minted successfully can still get 401'd on the actual
// quote call (documented real-world Yahoo behavior, distinct from a merely
// expired crumb). invalidateYahooCrumb() alone means the next call fetches
// a fresh crumb and retries with no backoff -- fine for one 401, but if a
// fresh crumb *also* gets 401'd repeatedly that's a sign of an IP-level
// block, not crumb staleness, and warrants the same cooldown a hard
// failure gets. Reset on any success.
let consecutive401s = 0;
const CONSECUTIVE_401_COOLDOWN_THRESHOLD = 2;

const fetchQuotes = async (symbols) => {
    const { cookie, crumb } = await getYahooCrumb();
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(",")}&crumb=${encodeURIComponent(crumb)}`;
    const res = await fetch(url, {
        headers: { "User-Agent": YAHOO_UA, Cookie: cookie },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status === 401) {
        invalidateYahooCrumb();
        consecutive401s += 1;
        if (consecutive401s >= CONSECUTIVE_401_COOLDOWN_THRESHOLD) {
            startYahooCooldown();
        }
        throw new Error("Yahoo crumb expired");
    }
    if (!res.ok) {
        startYahooCooldown();
        throw new Error(`Yahoo quote request failed (${res.status})`);
    }
    consecutive401s = 0;

    const body = await res.json();
    return body?.quoteResponse?.result || [];
};

// Dedupes concurrent identical requests (e.g. every open tab's poll firing
// in the same instant right after the shared 15s cache TTL rolls over) so
// they share one Yahoo fetch instead of each starting their own -- same
// single-flight pattern getYahooCrumb() already uses for the crumb itself.
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

async function fetchChart(symbol, chartRange) {
    const cacheKey = `us:chart:${symbol}:${chartRange}`;
    const interval = RANGE_TO_INTERVAL[chartRange];
    const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${chartRange}&interval=${interval}`,
        { headers: { "User-Agent": YAHOO_UA }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );
    if (!res.ok) {
        // Unlike fetchQuotes, this doesn't need a crumb, so a failure here
        // isn't crumb staleness -- it's Yahoo rejecting/rate-limiting this
        // endpoint outright. Back off the same way, otherwise a persistently
        // failing chart gets retried on every page load/range click with no
        // cooldown at all.
        startYahooCooldown();
        throw new Error(`Yahoo chart request failed (${res.status})`);
    }

    const body = await res.json();
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
