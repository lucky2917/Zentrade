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

const RESERVOIR_REFRESH_MS = 60 * 1000;

// The per-minute ceiling has to be shared, not per process.
//
// Bottleneck's reservoir lives in this process's memory while the daily budget
// counter lives in Redis. Two instances therefore permitted 2 x PER_MINUTE_CAP
// calls a minute against one shared daily budget, and the ceiling was violated
// by exactly the number of instances running — silently, because each instance
// was individually obeying it.
//
// One authoritative counter, incremented atomically, keyed by the minute it
// governs. Bottleneck stays for local smoothing (concurrency and spacing);
// this is what makes the ceiling real.
const MINUTE_KEY_PREFIX = "fyers:minute:";
const MINUTE_KEY_TTL_MS = 120 * 1000;

const CLAIM_MINUTE_SLOT = `
    local used = redis.call('incr', KEYS[1])
    if used == 1 then
        redis.call('pexpire', KEYS[1], ARGV[2])
    end
    if used > tonumber(ARGV[1]) then
        return 0
    end
    return 1
`;

export const minuteKeyFor = (nowMs) =>
    `${MINUTE_KEY_PREFIX}${Math.floor(nowMs / 60_000)}`;

// Returns false when this minute's shared allowance is already spent. The
// increment happens regardless, so a refused caller still counts against the
// minute it tried to use — which is what stops a thundering herd from each
// reading "under cap" and all proceeding.
export const claimMinuteSlot = async (nowMs = Date.now(), cap = PER_MINUTE_CAP) => {
    try {
        const allowed = await redis.eval(
            CLAIM_MINUTE_SLOT, 1, minuteKeyFor(nowMs), String(cap), String(MINUTE_KEY_TTL_MS));
        return Number(allowed) === 1;
    } catch (err) {
        // Fail CLOSED. An unreachable budget is not a licence to spend one: the
        // whole point of the shared counter is that no instance may proceed on
        // its own private belief about the ceiling.
        logger.error("RateLimiter", "shared minute budget unavailable, refusing REST",
                     { error: err.message });
        return false;
    }
};

const limiter = new Bottleneck({
    reservoir: PER_MINUTE_CAP,
    reservoirRefreshAmount: PER_MINUTE_CAP,
    reservoirRefreshInterval: RESERVOIR_REFRESH_MS,
    maxConcurrent: MODE_RATES.IDLE,
    minTime: Math.ceil(1000 / MODE_RATES.IDLE),
});

// Bottleneck cancels the reservoir refresh timer the first time updateSettings
// runs, and applyLimiterSettings runs on the first call of every process. The
// reservoir then drains to PER_MINUTE_CAP and never refills, so REST stops
// permanently after 180 calls. Refilling on our own timer restores the
// intended ceiling; it does not raise it.
const refillReservoir = async () => {
    const current = await limiter.currentReservoir();
    if (current !== null && current < PER_MINUTE_CAP) {
        await limiter.incrementReservoir(PER_MINUTE_CAP - current);
    }
};

const reservoirTimer = setInterval(() => {
    refillReservoir().catch((err) =>
        logger.error("RateLimiter", "Reservoir refill failed", { error: err.message })
    );
}, RESERVOIR_REFRESH_MS);
reservoirTimer.unref();

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
    // Concurrent callers (parallel isRestAllowed checks at IST midnight) race
    // here — NX lock makes the reset run once
    const acquired = await redis.set("fyers:reset_lock", "1", "EX", 60, "NX");
    if (!acquired) return;

    await redis.set(CALLS_USED_KEY, 0);
    await redis.set(RESET_AT_KEY, new Date().toISOString());
    await redis.del(ALERT_SENT_KEY);
    await redis.set(CURRENT_MODE_KEY, "IDLE");
    appliedMode = null;
    logger.info("RateLimiter", `Daily REST budget reset. ${TOTAL_BUDGET} calls available.`);
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

    // The shared ceiling is checked last, so a caller blocked by the daily
    // budget does not also consume a slot in this minute's allowance.
    if (!(await claimMinuteSlot())) {
        logger.warn("RateLimiter", "per-minute ceiling reached across all instances");
        return false;
    }
    return true;
};

const trackCall = async () => {
    await redis.incr(CALLS_USED_KEY);
};

const getRateLimiter = () => limiter;

export {
    getRateLimiter,
    MINUTE_KEY_TTL_MS,
    refillReservoir,
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
