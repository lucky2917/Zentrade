import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL);

export default redis;

/*
 * redis client. just connects to whatever REDIS_URL is set in env.
 * this is used everywhere — stock prices, chart cache, fundamentals,
 * basically any data that needs to be read fast goes through here.
 * almost every route and service file imports this.
 */
