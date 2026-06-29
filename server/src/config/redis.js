import Redis from "ioredis";
import logger from "../utils/logger.js";

const redis = new Redis(process.env.REDIS_URL, {
    retryStrategy: (times) => Math.min(times * 200, 5000),
    maxRetriesPerRequest: 5,
});

redis.on("error", (err) => logger.error("Redis", "Connection error", { error: err.message }));
redis.on("reconnecting", () => logger.warn("Redis", "Reconnecting..."));

export default redis;

/*
 * redis client. just connects to whatever REDIS_URL is set in env.
 * this is used everywhere — stock prices, chart cache, fundamentals,
 * basically any data that needs to be read fast goes through here.
 * almost every route and service file imports this.
 */
