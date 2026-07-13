import redis from "../config/redis.js";
import { STOCK_MAP } from "../config/stocks.js";
import { isMarketOpen } from "../utils/marketHours.js";
import logger from "../utils/logger.js";

const PRICE_CHANNEL = "price:update";
const EMIT_INTERVAL_MS = 1000;

const startWebSocketBroadcaster = (io) => {
    const stocks = {};
    const indices = {};
    let dirtyStocks = new Set();
    let dirtyIndices = new Set();

    const subscriber = redis.duplicate();

    subscriber.subscribe(PRICE_CHANNEL, (err) => {
        if (err) {
            logger.error("WebSocket", "Failed to subscribe to price:update", { error: err.message });
            return;
        }
        logger.info("WebSocket", "Subscribed to price:update");
    });

    subscriber.on("message", (channel, message) => {
        if (channel !== PRICE_CHANNEL) return;
        try {
            const data = JSON.parse(message);
            if (STOCK_MAP.has(data.symbol)) {
                stocks[data.symbol] = data;
                dirtyStocks.add(data.symbol);
            } else {
                indices[data.symbol] = data;
                dirtyIndices.add(data.symbol);
            }
        } catch (err) {
            logger.error("WebSocket", "Failed to parse price:update message", { error: err.message });
        }
    });

    const buildSnapshot = () => ({
        type: "market_update",
        data: stocks,
        indices,
        timestamp: Date.now(),
        isMarketOpen: isMarketOpen(),
    });

    setInterval(() => {
        if (dirtyStocks.size === 0 && dirtyIndices.size === 0) return;

        const delta = {
            type: "market_update",
            data: Object.fromEntries([...dirtyStocks].map((s) => [s, stocks[s]])),
            indices: Object.fromEntries([...dirtyIndices].map((s) => [s, indices[s]])),
            timestamp: Date.now(),
            isMarketOpen: isMarketOpen(),
        };
        dirtyStocks = new Set();
        dirtyIndices = new Set();

        io.emit("prices", delta);
    }, EMIT_INTERVAL_MS);

    io.on("connection", (socket) => {
        logger.info("WebSocket", `Client connected: ${socket.id}`);
        socket.emit("prices", buildSnapshot());

        socket.on("disconnect", () => {
            logger.info("WebSocket", `Client disconnected: ${socket.id}`);
        });
    });
};

export default startWebSocketBroadcaster;
