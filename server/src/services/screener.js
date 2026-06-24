import { getCandles } from "./fyers/fyersREST.js";
import { getWeeklyAvgVolume } from "./fyers/symbolManager.js";
import logger from "../utils/logger.js";
import { computeRSI, computeVWAP, computeSuperTrend } from "./technicalIndicators.js";

const PRICE_CEILING = 200;
const VOLUME_MULTIPLIER = 10;
const RSI_MIN = 40;
const RSI_MAX = 70;
const CANDLE_LOOKBACK_DAYS = 60;

const formatDate = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d;
};

const passesCheapFilters = async (symbol, price, volume) => {
    if (price == null || price >= PRICE_CEILING) return false;
    if (volume == null) return false;

    const weeklyAvg = await getWeeklyAvgVolume(symbol);
    if (!weeklyAvg || weeklyAvg <= 0) return false;

    return volume > weeklyAvg * VOLUME_MULTIPLIER;
};

const passesTechnicalFilters = async (symbol, price) => {
    const candles = await getCandles(symbol, "D", formatDate(daysAgo(CANDLE_LOOKBACK_DAYS)), formatDate(new Date()));
    if (candles.length < 20) return false;

    const closes = candles.map((c) => c.close).filter((v) => v != null);
    const rsi = computeRSI(closes);
    if (rsi == null || rsi < RSI_MIN || rsi > RSI_MAX) return false;

    const superTrend = computeSuperTrend(candles);
    if (!superTrend || !superTrend.bullish) return false;

    const vwap = computeVWAP(candles);
    if (vwap == null || price <= vwap) return false;

    return true;
};

const screenSymbol = async (symbol, price, volume) => {
    try {
        const cheapPass = await passesCheapFilters(symbol, price, volume);
        if (!cheapPass) return false;
        return await passesTechnicalFilters(symbol, price);
    } catch (err) {
        logger.error("Screener", `Screen failed for ${symbol}`, { error: err.message });
        return false;
    }
};

export { screenSymbol };
