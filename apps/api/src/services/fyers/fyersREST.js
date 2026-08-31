import { fyers, getAccessToken } from "./fyersAuth.js";
import { getRateLimiter, isRestAllowed, trackCall } from "./rateLimiter.js";
import { feedIsTrusted } from "./feedStatus.js";
import logger from "../../utils/logger.js";

const ensureAuthenticated = async () => {
    const token = await getAccessToken();
    if (!token) throw new Error("No Fyers access token available");
    fyers.setAccessToken(token);
};

// `essential` marks a call that must run even while the socket is healthy —
// history, and anything the socket cannot supply. Everything else is a
// backstop for data the websocket is already streaming, and running it anyway
// spends the budget that makes the backstop possible.
const call = async (fn, { essential = false } = {}) => {
    if (!essential && feedIsTrusted()) {
        logger.debug?.("FyersREST", "skipped: the websocket is delivering this");
        return null;
    }

    const allowed = await isRestAllowed();
    if (!allowed) {
        logger.error("FyersREST", "Call blocked, REST budget exhausted");
        return null;
    }

    // Check auth BEFORE scheduling: with no token every call is doomed, and
    // background pollers (MarketWorker, LaneManager, SymbolManager) keep
    // scheduling regardless. Without this, doomed calls still occupy a
    // queue slot and the rate limiter's throttle gap, so the shared queue
    // grows unbounded while token-less and starves real requests behind it.
    await ensureAuthenticated();

    // A network failure must not escape into a cron callback. These run on
    // timers with no caller to catch them, so a single ETIMEDOUT became an
    // uncaught exception and took the process down.
    try {
        return await getRateLimiter().schedule(async () => {
            const result = await fn();
            await trackCall();
            return result;
        });
    } catch (err) {
        logger.error("FyersREST", "call failed", { error: err.message, code: err.code });
        return null;
    }
};

const callEssential = (fn) => call(fn, { essential: true });

const getQuotes = async (symbols) => {
    if (symbols.length > 50) {
        throw new Error("getQuotes supports a maximum of 50 symbols per call");
    }
    try {
        return await call(() => fyers.getQuotes(symbols));
    } catch (err) {
        logger.error("FyersREST", "getQuotes failed", { error: err.message, symbols });
        return null;
    }
};

const getMarketDepth = async (symbol) => {
    try {
        // The socket carries last price and volume, not the order book, so
        // depth is genuinely REST-only and runs regardless of the feed.
        return await callEssential(() => fyers.getMarketDepth({ symbol: [symbol], ohlcv_flag: 1 }));
    } catch (err) {
        logger.error("FyersREST", "getMarketDepth failed", { error: err.message, symbol });
        return null;
    }
};

const getHistoricalData = async (symbol, resolution, fromDate, toDate) => {
    try {
        // History has no websocket equivalent, so it runs regardless of the
        // feed's health. It is also low frequency.
        return await callEssential(() => fyers.getHistory({
            symbol,
            resolution,
            date_format: "1",
            range_from: fromDate,
            range_to: toDate,
            cont_flag: "1",
        }));
    } catch (err) {
        logger.error("FyersREST", "getHistoricalData failed", { error: err.message, symbol });
        return null;
    }
};

const CHUNK_LIMIT_DAYS = {
    "1": 100, "2": 100, "3": 100, "5": 100, "10": 100, "15": 100, "20": 100,
    "30": 100, "45": 100, "60": 100, "120": 100, "180": 100, "240": 100,
    "D": 366, "1W": 366, "1M": 366,
};

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Fyers interprets range_from/range_to as IST trading dates. toISOString() is
// UTC, so any instant between 00:00 and 05:30 IST formatted to the PREVIOUS
// day and silently shifted every requested window by one session. The 03:31
// IST budget reset sits inside that band.
const formatDate = (date) => new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const daysAgo = (n) => {
    const d = new Date();
    d.setTime(d.getTime() - n * 24 * 60 * 60 * 1000);
    return d;
};

const parseCandles = (response) => {
    if (!response || response.s !== "ok" || !Array.isArray(response.candles)) return [];
    return response.candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
};

/**
 * Chunked history. Returns candles only, so a caller cannot tell an empty
 * range from a failed request; getCandlesDetailed exists for callers that
 * need to. A failing chunk is logged rather than silently dropped.
 */
const getCandles = async (symbol, resolution, fromDate, toDate) => {
    const limitDays = CHUNK_LIMIT_DAYS[String(resolution)] ?? 366;

    const from = new Date(fromDate);
    const to = new Date(toDate);
    const chunks = [];
    let chunkStart = new Date(from);
    while (chunkStart < to) {
        const chunkEnd = new Date(chunkStart);
        chunkEnd.setDate(chunkEnd.getDate() + limitDays - 1);
        if (chunkEnd > to) chunkEnd.setTime(to.getTime());
        chunks.push([formatDate(chunkStart), formatDate(chunkEnd)]);
        chunkStart = new Date(chunkEnd);
        chunkStart.setDate(chunkStart.getDate() + 1);
    }
    if (chunks.length === 0) chunks.push([formatDate(from), formatDate(to)]);

    const results = await Promise.all(chunks.map(([f, t]) => getHistoricalData(symbol, resolution, f, t)));
    const failed = results.filter((r) => !r || r.s !== "ok").length;
    if (failed > 0) {
        logger.error("FyersREST", "history chunks failed, result is incomplete", {
            symbol, resolution, failed, total: chunks.length,
        });
    }
    return results.flatMap(parseCandles);
};

/**
 * Same fetch, but the outcome of every chunk is visible. A depth probe cannot
 * use getCandles: an errored chunk there is indistinguishable from the edge of
 * the archive, which would understate history rather than report a failure.
 */
const getCandlesDetailed = async (symbol, resolution, fromDate, toDate) => {
    const limitDays = CHUNK_LIMIT_DAYS[String(resolution)] ?? 366;
    const from = new Date(fromDate);
    const to = new Date(toDate);
    const chunks = [];
    let chunkStart = new Date(from);
    while (chunkStart < to) {
        const chunkEnd = new Date(chunkStart);
        chunkEnd.setTime(chunkEnd.getTime() + (limitDays - 1) * 24 * 60 * 60 * 1000);
        if (chunkEnd > to) chunkEnd.setTime(to.getTime());
        chunks.push([formatDate(chunkStart), formatDate(chunkEnd)]);
        chunkStart = new Date(chunkEnd.getTime() + 24 * 60 * 60 * 1000);
    }
    if (chunks.length === 0) chunks.push([formatDate(from), formatDate(to)]);

    const responses = await Promise.all(
        chunks.map(([f, t]) => getHistoricalData(symbol, resolution, f, t))
    );
    return chunks.map(([f, t], index) => {
        const response = responses[index];
        if (response === null) return { from: f, to: t, outcome: "blocked", candles: [] };
        if (typeof response !== "object") return { from: f, to: t, outcome: "malformed", candles: [] };
        if (response.s !== "ok") {
            return { from: f, to: t, outcome: "error", code: response.code ?? null,
                     message: String(response.message ?? "").slice(0, 120), candles: [] };
        }
        const candles = parseCandles(response);
        return { from: f, to: t, outcome: candles.length ? "data" : "empty", candles };
    });
};

const RANGE_TO_FYERS = {
    "1d": { resolution: "1", days: 1 },
    "5d": { resolution: "5", days: 5 },
    "1mo": { resolution: "60", days: 30 },
    "3mo": { resolution: "D", days: 90 },
    "1y": { resolution: "D", days: 365 },
    "5y": { resolution: "1W", days: 365 * 5 },
};

const getCandlesForRange = async (symbol, rangeKey) => {
    const config = RANGE_TO_FYERS[rangeKey];
    if (!config) throw new Error(`Unsupported range: ${rangeKey}`);

    const toDate = formatDate(new Date());
    const fromDate = formatDate(daysAgo(config.days));
    return getCandles(symbol, config.resolution, fromDate, toDate);
};

export { getQuotes, getMarketDepth, getHistoricalData, getCandles, getCandlesDetailed, getCandlesForRange, formatDate, CHUNK_LIMIT_DAYS, RANGE_TO_FYERS };
