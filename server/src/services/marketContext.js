import logger from "../utils/logger.js";

const CACHE_TTL = 300; // 5 min — index data changes slowly enough

async function fetchIndexQuote(yahooSymbol) {
    const encoded = encodeURIComponent(yahooSymbol);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=5d`;
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
            signal: AbortSignal.timeout(6000),
        });
        if (!res.ok) return null;

        const data = await res.json();
        const result = data.chart?.result?.[0];
        const q = result?.indicators?.quote?.[0];
        if (!result?.timestamp || !q) return null;

        const len = result.timestamp.length;
        const closes = q.close.filter(Boolean);
        const opens   = q.open;

        const todayClose   = q.close[len - 1];
        const todayOpen    = opens[len - 1];
        const prevClose    = len > 1 ? q.close[len - 2] : todayOpen;

        if (!todayClose || !todayOpen || !prevClose) return null;

        const changePercent  = Math.round(((todayClose - prevClose) / prevClose) * 10000) / 100;
        const pctFromOpen    = Math.round(((todayClose - todayOpen) / todayOpen) * 10000) / 100;
        const aboveDailyOpen = todayClose > todayOpen;

        // 5-day trend: compare today vs 5 sessions ago
        const oldest = closes[0];
        const trend5d = oldest
            ? Math.round(((todayClose - oldest) / oldest) * 10000) / 100
            : 0;

        return {
            symbol:       yahooSymbol,
            price:        Math.round(todayClose * 100) / 100,
            changePercent,
            pctFromOpen,
            aboveDailyOpen,
            trend5d,
        };
    } catch (err) {
        logger.error("MarketContext", `Failed to fetch ${yahooSymbol}: ${err.message}`);
        return null;
    }
}

// Returns { nifty, sector } — either field can be null if fetch fails
export async function getMarketContext(sectorIndexSymbol, redisClient) {
    const key = `mkt:ctx:${sectorIndexSymbol ?? "none"}`;
    try {
        const cached = await redisClient.get(key);
        if (cached) return JSON.parse(cached);
    } catch (_) { /* redis miss — continue */ }

    const [nifty, sector] = await Promise.all([
        fetchIndexQuote("^NSEI"),
        sectorIndexSymbol ? fetchIndexQuote(sectorIndexSymbol) : Promise.resolve(null),
    ]);

    const ctx = { nifty, sector };

    try {
        await redisClient.setex(key, CACHE_TTL, JSON.stringify(ctx));
    } catch (_) { /* non-fatal */ }

    logger.info("MarketContext", `Nifty: ${nifty?.changePercent ?? "N/A"}% | Sector (${sectorIndexSymbol ?? "none"}): ${sector?.changePercent ?? "N/A"}%`);
    return ctx;
}

// Human-readable summary injected into the synthesizer prompt
export function describeMarketContext(ctx, stockSector) {
    const lines = [];

    if (ctx.nifty) {
        const n = ctx.nifty;
        const mood = n.changePercent > 1 ? "strong bull"
            : n.changePercent > 0.3 ? "mildly bullish"
            : n.changePercent < -1 ? "strong bear"
            : n.changePercent < -0.3 ? "mildly bearish"
            : "flat";
        lines.push(`NIFTY 50: ${n.changePercent > 0 ? "+" : ""}${n.changePercent}% today (${mood}) | ${n.aboveDailyOpen ? "Above" : "Below"} day open | 5-day trend: ${n.trend5d > 0 ? "+" : ""}${n.trend5d}%`);
    } else {
        lines.push("NIFTY 50: Data unavailable");
    }

    if (ctx.sector) {
        const s = ctx.sector;
        const mood = s.changePercent > 0.8 ? "strong sectoral tailwind"
            : s.changePercent > 0.2 ? "sector mildly positive"
            : s.changePercent < -0.8 ? "strong sectoral headwind"
            : s.changePercent < -0.2 ? "sector mildly negative"
            : "sector flat";
        lines.push(`${stockSector} SECTOR: ${s.changePercent > 0 ? "+" : ""}${s.changePercent}% today (${mood})`);
    } else {
        lines.push(`${stockSector} SECTOR: No dedicated index tracked`);
    }

    return lines.join("\n");
}

// Numeric macro signal for the consensus override (-1 bearish, 0 neutral, +1 bullish)
export function macroSignal(ctx) {
    const niftyPct = ctx.nifty?.changePercent ?? 0;
    const sectorPct = ctx.sector?.changePercent ?? 0;
    const combined = (niftyPct + sectorPct) / 2;
    if (combined > 0.4) return 1;
    if (combined < -0.4) return -1;
    return 0;
}
