import Bottleneck from "bottleneck";
import redis from "../../config/redis.js";
import logger from "../../utils/logger.js";

const CALLS_USED_KEY = "fyers:calls_used_today";
const CURRENT_MODE_KEY = "fyers:current_mode";
const RESET_AT_KEY = "fyers:calls_reset_at";
const ALERT_SENT_KEY = "fyers:budget_alert_sent";

const DEPTH_BUDGET = 9600;
const SLOW_BUDGET = 18750;
const VOLUME_BUDGET = 1500;
const PREMARKET_BUDGET = 1875;
const BUFFER = 68275;
const TOTAL_BUDGET = 100000;

const MODE_RATES = { TURBO: 10, HIGH: 8, LOW: 3, IDLE: 1 };
const PER_MINUTE_CAP = 180;

const LOW_BUDGET_THRESHOLD = 5000;
const BLOCK_THRESHOLD = 1000;
const EMERGENCY_THRESHOLD = 500;

const limiter = new Bottleneck({
    reservoir: PER_MINUTE_CAP,
    reservoirRefreshAmount: PER_MINUTE_CAP,
    reservoirRefreshInterval: 60 * 1000,
    maxConcurrent: MODE_RATES.IDLE,
    minTime: Math.ceil(1000 / MODE_RATES.IDLE),
});

let appliedMode = null;
let budgetAlertHandler = null;

const setBudgetAlertHandler = (fn) => {
    budgetAlertHandler = fn;
};

const getIST = () => {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    return new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);
};

const getTimeBasedMode = () => {
    const ist = getIST();
    const minutesSinceMidnight = ist.getHours() * 60 + ist.getMinutes();

    const marketOpen = 9 * 60 + 15;
    const turboEnd = 9 * 60 + 30;
    const lowStart = 11 * 60 + 30;
    const lowEnd = 14 * 60;
    const marketClose = 15 * 60 + 30;

    if (minutesSinceMidnight < marketOpen || minutesSinceMidnight >= marketClose) return "IDLE";
    if (minutesSinceMidnight < turboEnd) return "TURBO";
    if (minutesSinceMidnight < lowStart) return "HIGH";
    if (minutesSinceMidnight < lowEnd) return "LOW";
    return "HIGH";
};

const computeMode = (remaining) => {
    if (remaining < LOW_BUDGET_THRESHOLD) return "LOW";
    return getTimeBasedMode();
};

const applyLimiterSettings = async (mode) => {
    if (mode === appliedMode) return;
    const rate = MODE_RATES[mode];
    await limiter.updateSettings({
        maxConcurrent: rate,
        minTime: Math.ceil(1000 / rate),
    });
    appliedMode = mode;
};

const getRemainingBudget = async () => {
    const used = Number(await redis.get(CALLS_USED_KEY)) || 0;
    return TOTAL_BUDGET - used;
};

const resetDailyBudget = async () => {
    await redis.set(CALLS_USED_KEY, 0);
    await redis.set(RESET_AT_KEY, new Date().toISOString());
    await redis.del(ALERT_SENT_KEY);
    await redis.set(CURRENT_MODE_KEY, "IDLE");
    appliedMode = null;
    logger.info("RateLimiter", "Daily REST budget reset. 100000 calls available.");
};

const ensureFreshDay = async () => {
    const resetAt = await redis.get(RESET_AT_KEY);
    if (!resetAt) {
        await resetDailyBudget();
        return;
    }

    const resetDate = new Date(resetAt);
    const istOffset = 5.5 * 60 * 60 * 1000;
    const lastResetIST = new Date(resetDate.getTime() + istOffset + resetDate.getTimezoneOffset() * 60 * 1000);
    const nowIST = getIST();
    const sameDay =
        lastResetIST.getFullYear() === nowIST.getFullYear() &&
        lastResetIST.getMonth() === nowIST.getMonth() &&
        lastResetIST.getDate() === nowIST.getDate();

    if (!sameDay) await resetDailyBudget();
};

const getCurrentMode = async () => {
    const remaining = await getRemainingBudget();
    const mode = computeMode(remaining);
    await redis.set(CURRENT_MODE_KEY, mode);
    await applyLimiterSettings(mode);
    return mode;
};

const isRestAllowed = async () => {
    await ensureFreshDay();
    const remaining = await getRemainingBudget();

    if (remaining < EMERGENCY_THRESHOLD && budgetAlertHandler) {
        const alreadySent = await redis.get(ALERT_SENT_KEY);
        if (!alreadySent) {
            await redis.set(ALERT_SENT_KEY, "1");
            budgetAlertHandler(remaining).catch((err) =>
                logger.error("RateLimiter", "Budget alert failed to send", { error: err.message })
            );
        }
    }

    if (remaining < BLOCK_THRESHOLD) {
        logger.error("RateLimiter", `REST blocked, only ${remaining} calls left today`);
        return false;
    }

    const mode = computeMode(remaining);
    await redis.set(CURRENT_MODE_KEY, mode);
    await applyLimiterSettings(mode);
    return true;
};

const trackCall = async () => {
    await redis.incr(CALLS_USED_KEY);
};

const getRateLimiter = () => limiter;

export {
    getRateLimiter,
    getCurrentMode,
    getRemainingBudget,
    trackCall,
    isRestAllowed,
    resetDailyBudget,
    setBudgetAlertHandler,
    DEPTH_BUDGET,
    SLOW_BUDGET,
    VOLUME_BUDGET,
    PREMARKET_BUDGET,
    BUFFER,
    TOTAL_BUDGET,
    PER_MINUTE_CAP,
};
