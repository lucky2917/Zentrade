import redis from "../config/redis.js";
import { STOCKS } from "../config/stocks.js";

const startWebSocketBroadcaster = (io) => {
    setInterval(async () => {
        try {
            const pipeline = redis.pipeline();
            STOCKS.forEach((stock) => pipeline.get(`stock:${stock.symbol}`));
            const results = await pipeline.exec();

            const prices = {};
            STOCKS.forEach((stock, i) => {
                if (results[i][1]) {
                    prices[stock.symbol] = JSON.parse(results[i][1]);
                }
            });

            io.emit("prices", prices);
        } catch (err) {
            console.error("WebSocket broadcast error:", err.message);
        }
    }, 3000);
};

export default startWebSocketBroadcaster;
