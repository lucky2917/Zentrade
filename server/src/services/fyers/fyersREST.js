import Bottleneck from "bottleneck";
import { fyers, getAccessToken } from "./fyersAuth.js";
import logger from "../../utils/logger.js";

const MINUTE_LIMIT = 200;
const DAY_LIMIT = 100000;

const limiter = new Bottleneck({
    reservoir: 10,
    reservoirRefreshAmount: 10,
    reservoirRefreshInterval: 1000,
    maxConcurrent: 10,
});

let minuteCount = 0;
let dayCount = 0;
setInterval(() => { minuteCount = 0; }, 60 * 1000);
setInterval(() => { dayCount = 0; }, 24 * 60 * 60 * 1000);

const trackUsage = () => {
    minuteCount++;
    dayCount++;
    if (minuteCount === Math.floor(MINUTE_LIMIT * 0.8)) {
        logger.warn("FyersREST", `Approaching per-minute rate limit: ${minuteCount}/${MINUTE_LIMIT}`);
    }
    if (dayCount === Math.floor(DAY_LIMIT * 0.8)) {
        logger.warn("FyersREST", `Approaching daily rate limit: ${dayCount}/${DAY_LIMIT}`);
    }
};

const ensureAuthenticated = async () => {
    const token = await getAccessToken();
    if (!token) throw new Error("No Fyers access token available");
    fyers.setAccessToken(token);
};

const call = (fn) => limiter.schedule(async () => {
    await ensureAuthenticated();
    trackUsage();
    return fn();
});

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

export { getQuotes, getMarketDepth, getHistoricalData };
