import redis from "../config/redis.js";
import { STOCKS } from "../config/stocks.js";
import { INDICES } from "./marketWorker.js";
import logger from "../utils/logger.js";

const startWebSocketBroadcaster = (io) => {
    setInterval(async () => {
        try {
            const pipeline = redis.pipeline();
            STOCKS.forEach((stock) => pipeline.get(`stock:${stock.symbol}`));
            INDICES.forEach((index) => pipeline.get(`index:${index.symbol}`));
            const results = await pipeline.exec();

            const stocks = {};
            STOCKS.forEach((stock, i) => {
                if (results[i][1]) {
                    stocks[stock.symbol] = JSON.parse(results[i][1]);
                }
            });

            const indices = {};
            INDICES.forEach((index, i) => {
                const idx = STOCKS.length + i;
                if (results[idx][1]) {
                    indices[index.symbol] = JSON.parse(results[idx][1]);
                }
            });

            io.emit("prices", {
                type: "market_update",
                data: stocks,
                indices,
                timestamp: Date.now(),
            });
        } catch (err) {
            logger.error("WebSocket", "Broadcast failed", { error: err.message });
        }
    }, 3000);

    io.on("connection", (socket) => {
        logger.info("WebSocket", `Client connected: ${socket.id}`);
        socket.on("disconnect", () => {
            logger.info("WebSocket", `Client disconnected: ${socket.id}`);
        });
    });
};

export default startWebSocketBroadcaster;
