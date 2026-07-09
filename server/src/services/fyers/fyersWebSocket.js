import { fyersDataSocket } from "fyers-api-v3";
import redis from "../../config/redis.js";
import { getWebSocketToken } from "./fyersAuth.js";
import { sanitiseTick, toFyersStockSymbol, FYERS_INDEX_SYMBOLS } from "./smartWall.js";
import { STOCK_MAP } from "../../config/stocks.js";
import logger from "../../utils/logger.js";

const MAX_SYMBOLS = 200;
const PRICE_CHANNEL = "price:update";
const MAX_BACKOFF_MS = 30000;
const LOG_PATH = process.env.FYERS_WS_LOG_PATH || "./logs";

let socket = null;
let subscribedSymbols = new Set();
let reconnectAttempts = 0;
let reconnectTimer = null;
let intentionalClose = false;

const cacheAndPublish = async (sanitised) => {
    const key = STOCK_MAP.has(sanitised.symbol)
        ? `stock:${sanitised.symbol}`
        : `index:${sanitised.symbol}`;

    const payload = JSON.stringify(sanitised);
    await redis.set(key, payload);
    await redis.publish(PRICE_CHANNEL, payload);
};

const handleMessage = (message) => {
    const ticks = Array.isArray(message) ? message : [message];

    for (const tick of ticks) {
        try {
            const sanitised = sanitiseTick(tick);
            if (sanitised) cacheAndPublish(sanitised);
        } catch (err) {
            logger.error("FyersWebSocket", "Failed to process tick", { error: err.message });
        }
    }
};

const scheduleReconnect = () => {
    if (intentionalClose) return;
    const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_BACKOFF_MS);
    reconnectAttempts++;
    logger.warn("FyersWebSocket", `Reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(connect, delay);
};

const connect = async () => {
    const token = await getWebSocketToken();
    if (!token) {
        logger.error("FyersWebSocket", "No access token available, cannot connect");
        scheduleReconnect();
        return;
    }

    intentionalClose = false;
    socket = fyersDataSocket.getInstance(token, LOG_PATH, false);

    socket.on("connect", () => {
        reconnectAttempts = 0;
        logger.info("FyersWebSocket", "Connected");
        if (subscribedSymbols.size > 0) {
            socket.subscribe([...subscribedSymbols]);
        }
    });

    socket.on("message", handleMessage);

    socket.on("error", (err) => {
        logger.error("FyersWebSocket", "Socket error", { error: err?.message || err });
    });

    socket.on("close", () => {
        logger.warn("FyersWebSocket", "Connection closed");
        if (!intentionalClose) scheduleReconnect();
    });

    socket.connect();
};

const subscribe = (symbols) => {
    const fyersSymbols = symbols.map((s) =>
        STOCK_MAP.has(s) ? toFyersStockSymbol(s) : FYERS_INDEX_SYMBOLS[s]
    ).filter(Boolean);

    const next = new Set([...subscribedSymbols, ...fyersSymbols]);
    if (next.size > MAX_SYMBOLS) {
        throw new Error(`Cannot subscribe: would exceed Fyers' ${MAX_SYMBOLS}-symbol limit per connection`);
    }

    subscribedSymbols = next;
    if (socket && socket.isConnected && socket.isConnected()) {
        socket.subscribe(fyersSymbols);
    }
};

const stop = () => {
    intentionalClose = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (socket) socket.close();
};

export { connect, subscribe, stop };
