import cron from "node-cron";
import redis from "../../config/redis.js";
import logger from "../../utils/logger.js";
import { isMarketOpen } from "../../utils/marketHours.js";
import { getQuotes, getCandles } from "./fyersREST.js";
import { stripFyersSymbol } from "./smartWall.js";
import { getRateLimiter, isRestAllowed, trackCall } from "./rateLimiter.js";
import { TIER_1, TIER_2, TIER_3 } from "../../config/watchlist.js";

const TIER1_KEY = "fyers:tier1_symbols";
const TIER2_KEY = "fyers:tier2_symbols";

const MAX_TIER1 = 20;
const PROMOTE_MULTIPLIER = 5;
const DEMOTE_AFTER_MS = 30 * 60 * 1000;
const QUOTE_BATCH_SIZE = 50;

const VOLUME_TTL = 24 * 60 * 60;
const WEEKLY_AVG_TTL = 7 * 24 * 60 * 60;
const WEEKLY_AVG_FAIL_TTL = 60 * 60;
const PROMOTED_AT_TTL = 24 * 60 * 60;

const volumeTrackerKey = (root) => `volume_tracker:${root}`;
const weeklyAvgKey = (root) => `weekly_avg:${root}`;
const promotedAtKey = (root) => `promoted_at:${root}`;

const readTierArray = async (key, fallback) => {
    const raw = await redis.get(key);
    if (!raw) return [...fallback];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [...fallback];
    } catch {
        return [...fallback];
    }
};

const writeTierArray = async (key, arr) => redis.set(key, JSON.stringify(arr));

const getCurrentTier1 = () => readTierArray(TIER1_KEY, TIER_1);
const getCurrentTier2 = () => readTierArray(TIER2_KEY, TIER_2);

const getSymbolTier = async (symbol) => {
    const tier1 = await getCurrentTier1();
    if (tier1.includes(symbol)) return 1;
    const tier2 = await getCurrentTier2();
    if (tier2.includes(symbol)) return 2;
    if (TIER_3.includes(symbol)) return 3;
    return null;
};

const updateVolume = async (symbol, volume) => {
    const root = stripFyersSymbol(symbol);
    await redis.set(volumeTrackerKey(root), volume, "EX", VOLUME_TTL);
};

const extractVolume = (quoteValues) => quoteValues.vol_traded_today ?? quoteValues.volume ?? null;

const getWeeklyAvgVolume = async (symbol) => {
    const root = stripFyersSymbol(symbol);
    const cached = await redis.get(weeklyAvgKey(root));
    if (cached !== null) return cached === "" ? null : Number(cached);

    try {
        const to = new Date();
        const from = new Date();
        from.setDate(from.getDate() - 7);
        const formatDate = (d) => d.toISOString().slice(0, 10);

        const candles = await getCandles(symbol, "D", formatDate(from), formatDate(to));
        const volumes = candles.map((c) => c.volume).filter((v) => v != null && v > 0);

        if (volumes.length === 0) {
            await redis.set(weeklyAvgKey(root), "", "EX", WEEKLY_AVG_FAIL_TTL);
            return null;
        }

        const avg = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
        await redis.set(weeklyAvgKey(root), avg, "EX", WEEKLY_AVG_TTL);
        return avg;
    } catch (err) {
        logger.error("SymbolManager", `Failed to compute weekly avg volume for ${symbol}`, { error: err.message });
        await redis.set(weeklyAvgKey(root), "", "EX", WEEKLY_AVG_FAIL_TTL);
        return null;
    }
};

const findLowestVolumeMember = async (tier1) => {
    let lowestSymbol = null;
    let lowestVolume = Infinity;

    for (const symbol of tier1) {
        const root = stripFyersSymbol(symbol);
        const volume = Number(await redis.get(volumeTrackerKey(root))) || 0;
        if (volume < lowestVolume) {
            lowestVolume = volume;
            lowestSymbol = symbol;
        }
    }

    return lowestSymbol;
};

const demoteSymbol = async (symbol) => {
    const tier1 = await getCurrentTier1();
    if (!tier1.includes(symbol)) return;

    await writeTierArray(TIER1_KEY, tier1.filter((s) => s !== symbol));
    await redis.del(promotedAtKey(stripFyersSymbol(symbol)));

    if (!TIER_3.includes(symbol)) {
        const tier2 = await getCurrentTier2();
        if (!tier2.includes(symbol)) {
            await writeTierArray(TIER2_KEY, [...tier2, symbol]);
        }
    }

    logger.info("SymbolManager", `Demoted ${symbol} from tier 1`);
};

const promoteSymbol = async (symbol) => {
    let tier1 = await getCurrentTier1();
    if (tier1.includes(symbol)) return;

    if (tier1.length >= MAX_TIER1) {
        const lowest = await findLowestVolumeMember(tier1);
        if (!lowest || lowest === symbol) return;
        await demoteSymbol(lowest);
        tier1 = await getCurrentTier1();
    }

    await writeTierArray(TIER1_KEY, [...tier1, symbol]);
    await redis.set(promotedAtKey(stripFyersSymbol(symbol)), Date.now(), "EX", PROMOTED_AT_TTL);

    const tier2 = await getCurrentTier2();
    if (tier2.includes(symbol)) {
        await writeTierArray(TIER2_KEY, tier2.filter((s) => s !== symbol));
    }

    logger.info("SymbolManager", `Promoted ${symbol} to tier 1`);
};

const checkDemotions = async (tier1, volumeBySymbol) => {
    const now = Date.now();

    for (const symbol of tier1) {
        const root = stripFyersSymbol(symbol);
        const promotedAt = Number(await redis.get(promotedAtKey(root)));
        if (!promotedAt) continue;
        if (now - promotedAt < DEMOTE_AFTER_MS) continue;

        const weeklyAvg = await getWeeklyAvgVolume(symbol);
        const currentVolume = volumeBySymbol.get(symbol);
        if (weeklyAvg == null || currentVolume == null) continue;

        if (currentVolume < weeklyAvg * PROMOTE_MULTIPLIER) {
            await demoteSymbol(symbol);
        }
    }
};

const checkPromotions = async (candidates, volumeBySymbol) => {
    for (const symbol of candidates) {
        const currentVolume = volumeBySymbol.get(symbol);
        if (currentVolume == null) continue;

        const weeklyAvg = await getWeeklyAvgVolume(symbol);
        if (weeklyAvg == null) continue;

        if (currentVolume > weeklyAvg * PROMOTE_MULTIPLIER) {
            await promoteSymbol(symbol);
        }
    }
};

const fetchQuotesInBatches = async (symbols) => {
    const volumeBySymbol = new Map();

    for (let i = 0; i < symbols.length; i += QUOTE_BATCH_SIZE) {
        const batch = symbols.slice(i, i + QUOTE_BATCH_SIZE);

        const allowed = await isRestAllowed();
        if (!allowed) {
            logger.error("SymbolManager", "Volume scan aborted, REST budget exhausted");
            break;
        }

        const response = await getRateLimiter().schedule(() => getQuotes(batch));
        await trackCall();

        if (!response || response.s !== "ok" || !Array.isArray(response.d)) continue;

        for (const entry of response.d) {
            if (entry.s !== "ok" || !entry.v) continue;
            const volume = extractVolume(entry.v);
            if (volume == null) continue;
            volumeBySymbol.set(entry.n, volume);
            await updateVolume(entry.n, volume);
        }
    }

    return volumeBySymbol;
};

const runVolumeScan = async () => {
    if (!isMarketOpen()) return;

    const tier1 = await getCurrentTier1();
    const tier2 = await getCurrentTier2();
    const candidates = [...tier2, ...TIER_3.filter((s) => !tier1.includes(s))];

    const volumeBySymbol = await fetchQuotesInBatches(candidates);
    if (volumeBySymbol.size === 0) return;

    await checkDemotions(tier1, volumeBySymbol);
    const refreshedTier1 = await getCurrentTier1();
    const stillCandidates = candidates.filter((s) => !refreshedTier1.includes(s));
    await checkPromotions(stillCandidates, volumeBySymbol);

    logger.info("SymbolManager", `Volume scan complete, scanned ${volumeBySymbol.size} symbols`);
};

const initialise = async () => {
    const existingTier1 = await redis.get(TIER1_KEY);
    if (!existingTier1) await writeTierArray(TIER1_KEY, TIER_1);

    const existingTier2 = await redis.get(TIER2_KEY);
    if (!existingTier2) await writeTierArray(TIER2_KEY, TIER_2);

    logger.info("SymbolManager", "Tier arrays initialised");
};

const startSymbolManager = async () => {
    await initialise();
    cron.schedule("*/5 9-15 * * 1-5", runVolumeScan, { timezone: "Asia/Kolkata" });
    logger.info("SymbolManager", "Scheduled volume scan every 5 min during market hours");
};

export {
    startSymbolManager,
    getCurrentTier1,
    getCurrentTier2,
    promoteSymbol,
    demoteSymbol,
    updateVolume,
    getSymbolTier,
    getWeeklyAvgVolume,
};
