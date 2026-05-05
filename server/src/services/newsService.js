import logger from "../utils/logger.js";

// ─── Finnhub ──────────────────────────────────────────────────────────────────

async function queryFinnhub(symbol, fromStr, toStr, apiKey) {
    const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${fromStr}&to=${toStr}&token=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

// ─── Yahoo Finance news ───────────────────────────────────────────────────────
// More reliable for Indian stocks than Finnhub's free tier

async function queryYahooNews(yahooSymbol) {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(yahooSymbol)}&newsCount=6&lang=en&region=IN`;
    try {
        const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return [];
        const data = await res.json();
        const items = data?.news ?? [];
        return items
            .filter((n) => n.title && n.publisher)
            .map((n) => ({ headline: n.title, source: n.publisher }));
    } catch (err) {
        logger.error("NewsService", `Yahoo news failed for ${yahooSymbol}: ${err.message}`);
        return [];
    }
}

// ─── Main export ─────────────────────────────────────────────────────────────

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

    // Run Finnhub + Yahoo in parallel for maximum coverage
    const apiKey = process.env.FINNHUB_API_KEY;

    const [finnhubNS, yahooArticles] = await Promise.all([
        apiKey ? queryFinnhub(yahooSymbol, dateRange.from, dateRange.to, apiKey) : Promise.resolve([]),
        queryYahooNews(yahooSymbol),
    ]);

    // Finnhub fallback: try bare symbol if .NS returned nothing
    let finnhubArticles = finnhubNS;
    if (finnhubArticles.length === 0 && apiKey) {
        const bare = yahooSymbol.replace(".NS", "").replace(".BO", "");
        finnhubArticles = await queryFinnhub(bare, dateRange.from, dateRange.to, apiKey);
    }

    // Merge, deduplicate by headline prefix, take best 6
    const seen = new Set();
    const merged = [];
    for (const a of [...finnhubArticles.map((n) => ({ headline: n.headline, source: n.source })), ...yahooArticles]) {
        const key = a.headline?.slice(0, 40).toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(a);
        if (merged.length >= 6) break;
    }

    logger.info("NewsService", `${yahooSymbol}: ${merged.length} articles (${finnhubArticles.length} Finnhub + ${yahooArticles.length} Yahoo)`);
    return merged;
}
