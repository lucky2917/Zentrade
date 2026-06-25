import cron from "node-cron";
import redis from "../../config/redis.js";
import logger from "../../utils/logger.js";
import { getQuotes } from "./fyersREST.js";
import { isRestAllowed } from "./rateLimiter.js";
import { getCurrentTier1, getCurrentTier2 } from "./symbolManager.js";

const QUOTE_BATCH_SIZE = 50;
const PREOPEN_TTL = 60 * 60;
const GAP_TTL = 6 * 60 * 60;
const MORNING_WATCHLIST_TTL = 8 * 60 * 60;
const GAP_THRESHOLD_PCT = 2;
const WATCHLIST_GENERATION_MINUTE = 9 * 60 + 10;
const WINDOW_START_MINUTE = 8 * 60;
const WINDOW_END_MINUTE = 9 * 60 + 14;

const toRootSymbol = (fyersSymbol) => fyersSymbol.replace(/^(NSE|BSE):/, "").replace(/-EQ$/, "");

const getISTMinutes = () => {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const ist = new Date(now.getTime() + istOffset + now.getTimezoneOffset() * 60 * 1000);
    return ist.getHours() * 60 + ist.getMinutes();
};

const isPreMarketWindow = () => {
    const minutes = getISTMinutes();
    return minutes >= WINDOW_START_MINUTE && minutes <= WINDOW_END_MINUTE;
};

const fetchQuotesInBatches = async (symbols) => {
    const results = [];
    for (let i = 0; i < symbols.length; i += QUOTE_BATCH_SIZE) {
        const batch = symbols.slice(i, i + QUOTE_BATCH_SIZE);

        const allowed = await isRestAllowed();
        if (!allowed) {
            logger.error("PreMarketScanner", "Scan aborted, REST budget exhausted");
            break;
        }

        const response = await getQuotes(batch);
        if (!response || response.s !== "ok" || !Array.isArray(response.d)) continue;

        results.push(...response.d);
    }
    return results;
};

const computeGapPct = (preopenPrice, prevClose) =>
    prevClose > 0 ? Math.round(((preopenPrice - prevClose) / prevClose) * 10000) / 100 : null;

const generateMorningWatchlist = async (winners) => {
    await redis.set("morning_watchlist", JSON.stringify(winners), "EX", MORNING_WATCHLIST_TTL);
    logger.info("PreMarketScanner", `Morning watchlist ready: ${winners.map((w) => w.symbol).join(", ") || "none"}`);
};

const runPreMarketScan = async () => {
    if (!isPreMarketWindow()) return;

    const tier1 = await getCurrentTier1();
    const tier2 = await getCurrentTier2();
    const symbols = [...tier1, ...tier2];

    const quoteEntries = await fetchQuotesInBatches(symbols);
    const winners = [];

    for (const entry of quoteEntries) {
        if (entry.s !== "ok" || !entry.v) continue;

        const root = toRootSymbol(entry.n);
        const preopenPrice = entry.v.lp ?? entry.v.ltp;
        const prevClose = entry.v.prev_close_price;
        const volume = entry.v.vol_traded_today ?? entry.v.volume ?? 0;
        if (preopenPrice == null) continue;

        await redis.set(
            `preopen:${root}`,
            JSON.stringify({ price: preopenPrice, volume, timestamp: Date.now() }),
            "EX",
            PREOPEN_TTL
        );

        const gapPct = computeGapPct(preopenPrice, prevClose);
        if (gapPct == null) continue;

        await redis.set(`gap:${root}`, gapPct, "EX", GAP_TTL);

        if (gapPct > GAP_THRESHOLD_PCT && volume > 0) {
            winners.push({ symbol: entry.n, gapPct, volume });
        }
    }

    logger.info(
        "PreMarketScanner",
        `Scan complete: ${quoteEntries.length} symbols, ${winners.length} showing gap > ${GAP_THRESHOLD_PCT}% with volume building`
    );

    if (getISTMinutes() >= WATCHLIST_GENERATION_MINUTE) {
        await generateMorningWatchlist(winners);
    }
};

const getMorningWatchlist = async () => {
    const raw = await redis.get("morning_watchlist");
    return raw ? JSON.parse(raw) : [];
};

const startPreMarketScanner = () => {
    cron.schedule("*/2 8-9 * * 1-5", runPreMarketScan, { timezone: "Asia/Kolkata" });
    logger.info("PreMarketScanner", "Scheduled pre-market scan every 2 min, 8:00-9:14 AM IST");
};

export { startPreMarketScanner, getMorningWatchlist };
