import logger from "../utils/logger.js";

// ─── Finnhub ──────────────────────────────────────────────────────────────────

async function queryFinnhub(symbol, fromStr, toStr, apiKey) {
    const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${fromStr}&to=${toStr}&token=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

// ─── Main export ─────────────────────────────────────────────────────────────
// Yahoo's finance/search endpoint was tried here too, but its "news" field
// ignores the query symbol entirely (verified: RELIANCE.NS and TCS.NS return
// near-identical generic financial headlines), so it's not used.

export async function fetchStockNews(yahooSymbol) {
    const dateRange = (() => {
        const to = new Date();
        const from = new Date();
        from.setDate(from.getDate() - 7);
        return {
            to: to.toISOString().split("T")[0],
            from: from.toISOString().split("T")[0],
        };
    })();

    const apiKey = process.env.FINNHUB_API_KEY;
    if (!apiKey) return [];

    let finnhubArticles = await queryFinnhub(yahooSymbol, dateRange.from, dateRange.to, apiKey);

    // fallback: try bare symbol if .NS/.BO suffix returned nothing
    if (finnhubArticles.length === 0) {
        const bare = yahooSymbol.replace(".NS", "").replace(".BO", "");
        finnhubArticles = await queryFinnhub(bare, dateRange.from, dateRange.to, apiKey);
    }

    // Dedup by headline prefix, take best 6
    const seen = new Set();
    const merged = [];
    for (const n of finnhubArticles) {
        const key = n.headline?.slice(0, 40).toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push({ headline: n.headline, source: n.source });
        if (merged.length >= 6) break;
    }

    logger.info("NewsService", `${yahooSymbol}: ${merged.length} articles (Finnhub)`);
    return merged;
}
