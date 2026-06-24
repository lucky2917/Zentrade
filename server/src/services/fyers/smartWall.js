import { STOCK_MAP } from "../../config/stocks.js";
import logger from "../../utils/logger.js";

const INDICES = [
    { symbol: "NIFTY50", yahooSymbol: "^NSEI", name: "NIFTY 50" },
    { symbol: "SENSEX", yahooSymbol: "^BSESN", name: "SENSEX" },
    { symbol: "BANKNIFTY", yahooSymbol: "^NSEBANK", name: "BANK NIFTY" },
];

const stripFyersSymbol = (fyersSymbol) =>
    fyersSymbol.replace(/^(NSE|BSE):/, "").replace(/-(EQ|INDEX)$/, "");

const toFyersStockSymbol = (symbol) => `NSE:${symbol}-EQ`;

const FYERS_INDEX_SYMBOLS = {
    NIFTY50: "NSE:NIFTY50-INDEX",
    BANKNIFTY: "NSE:NIFTYBANK-INDEX",
    SENSEX: "BSE:SENSEX-INDEX",
};

const INDEX_MAP = new Map(INDICES.map((i) => [i.symbol, i]));

const computeChangePercent = (price, previousClose) =>
    previousClose > 0 ? Math.round(((price - previousClose) / previousClose) * 10000) / 100 : 0;

const readField = (tick, ...names) => {
    for (const name of names) {
        if (tick[name] !== undefined && tick[name] !== null) return tick[name];
    }
    return undefined;
};

let loggedRawSampleOnce = false;

const sanitiseTick = (rawTick) => {
    if (!loggedRawSampleOnce) {
        logger.info("SmartWall", "Raw Fyers tick sample (verify field names against this)", rawTick);
        loggedRawSampleOnce = true;
    }

    const fyersSymbol = readField(rawTick, "symbol", "n");
    if (!fyersSymbol) return null;

    const rootSymbol = stripFyersSymbol(fyersSymbol);

    const price = readField(rawTick, "ltp", "lp");
    if (!price) return null;

    const previousClose = readField(rawTick, "prev_close_price", "previousClose") || 0;
    const change = price - previousClose;
    const changePercent = computeChangePercent(price, previousClose);
    const timestamp = Date.now();

    const stock = STOCK_MAP.get(rootSymbol);
    if (stock) {
        return {
            symbol: stock.symbol,
            name: stock.name,
            price,
            change,
            changePercent,
            open: readField(rawTick, "open_price", "open") || 0,
            previousClose,
            dayHigh: readField(rawTick, "high_price", "high") || 0,
            dayLow: readField(rawTick, "low_price", "low") || 0,
            volume: readField(rawTick, "vol_traded_today", "volume") || 0,
            marketState: readField(rawTick, "market_status", "marketState") || "CLOSED",
            timestamp,
        };
    }

    const index = INDEX_MAP.get(rootSymbol);
    if (index) {
        return {
            symbol: index.symbol,
            name: index.name,
            price,
            change,
            changePercent,
            timestamp,
        };
    }

    return null;
};

export { sanitiseTick, stripFyersSymbol, toFyersStockSymbol, FYERS_INDEX_SYMBOLS, INDICES };
