import { fyers, getAccessToken } from "./fyersAuth.js";
import { getRateLimiter, isRestAllowed, trackCall } from "./rateLimiter.js";
import logger from "../../utils/logger.js";

const ensureAuthenticated = async () => {
    const token = await getAccessToken();
    if (!token) throw new Error("No Fyers access token available");
    fyers.setAccessToken(token);
};

const call = async (fn) => {
    const allowed = await isRestAllowed();
    if (!allowed) {
        logger.error("FyersREST", "Call blocked, REST budget exhausted");
        return null;
    }

    return getRateLimiter().schedule(async () => {
        await ensureAuthenticated();
        const result = await fn();
        await trackCall();
        return result;
    });
};

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
        return await call(() => fyers.getMarketDepth({ symbol: [symbol], ohlcv_flag: 1 }));
    } catch (err) {
        logger.error("FyersREST", "getMarketDepth failed", { error: err.message, symbol });
        return null;
    }
};

const getHistoricalData = async (symbol, resolution, fromDate, toDate) => {
    try {
        return await call(() => fyers.getHistory({
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

const formatDate = (date) => date.toISOString().slice(0, 10);

const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d;
};

const parseCandles = (response) => {
    if (!response || response.s !== "ok" || !Array.isArray(response.candles)) return [];
    return response.candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
};

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
    return results.flatMap(parseCandles);
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

export { getQuotes, getMarketDepth, getHistoricalData, getCandles, getCandlesForRange, RANGE_TO_FYERS };
