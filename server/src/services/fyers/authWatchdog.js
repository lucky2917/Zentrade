import cron from "node-cron";
import redis from "../../config/redis.js";
import logger from "../../utils/logger.js";
import { generateAuthCodeUrl, isConfigured } from "./fyersAuth.js";

const WARNING_THRESHOLD_MS = 60 * 60 * 1000;
const URGENT_THRESHOLD_MS = 30 * 60 * 1000;

const formatIST = (date) => date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

const safeAuthUrl = () => {
    try {
        return generateAuthCodeUrl();
    } catch {
        return null;
    }
};

const checkTokenExpiry = async () => {
    if (!isConfigured()) return;

    const expiryRaw = await redis.get("fyers:token_expiry");
    if (!expiryRaw) {
        logger.warn("AuthWatchdog", "No fyers:token_expiry in redis, not authenticated yet");
        return;
    }

    const expiryMs = Number(expiryRaw);
    const remainingMs = expiryMs - Date.now();
    const now = new Date();
    const details = {
        currentTimeIST: formatIST(now),
        expiryTimeIST: formatIST(new Date(expiryMs)),
        reauthUrl: safeAuthUrl(),
    };

    if (remainingMs <= 0) {
        logger.error("AuthWatchdog", "Fyers token has EXPIRED, re-authenticate now", { ...details, urgency: "EXPIRED" });
    } else if (remainingMs < URGENT_THRESHOLD_MS) {
        logger.error("AuthWatchdog", `Fyers token expires in ${Math.round(remainingMs / 60000)} min, re-authenticate now`, { ...details, urgency: "URGENT" });
    } else if (remainingMs < WARNING_THRESHOLD_MS) {
        logger.warn("AuthWatchdog", `Fyers token expires in ${Math.round(remainingMs / 60000)} min`, { ...details, urgency: "WARNING" });
    }
};

const startAuthWatchdog = () => {
    cron.schedule("*/30 * * * *", checkTokenExpiry);
    logger.info("AuthWatchdog", "Scheduled fyers token expiry check every 30 min");
};

export { startAuthWatchdog, checkTokenExpiry };
