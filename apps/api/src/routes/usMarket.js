import { Router } from "express";
import auth from "../middleware/auth.js";
import logger from "../utils/logger.js";
import { listUsStocks, getUsQuotes, getUsChart, VALID_RANGES } from "../services/usMarketData.js";
import { US_STOCK_MAP } from "../config/usStocks.js";

const router = Router();

/**
 * US Market. Two independent halves under one route file:
 *
 *  - /stocks, /stock/:symbol/full -- real market data straight from Yahoo
 *    Finance (via the existing yahooCrumb service), entirely within
 *    ZenTrade's own Node backend. No dependency on us_agent being up.
 *
 *  - /positions, /predict/:symbol -- proxy to the separately-run us_agent
 *    platform (AI-Trader, port 8000) and predict service (port 8001).
 *    Not part of ZenTrade's own architecture or contracts -- a thin,
 *    explicitly-labeled bridge to a sibling project that only exists when
 *    both are running locally. Never fails silently: connection errors
 *    surface as a clear "agent not running" response instead of a bare
 *    500, since that's the expected state whenever the US side isn't
 *    started.
 */

router.get("/stocks", auth, async (_req, res) => {
    try {
        const list = listUsStocks();
        const quotes = await getUsQuotes(list.map((s) => s.symbol));
        const quotesBySymbol = new Map(quotes.map((q) => [q.symbol, q]));
        res.json(
            list.map((s) => {
                const q = quotesBySymbol.get(s.symbol);
                return {
                    symbol: s.symbol,
                    name: s.name,
                    price: q?.regularMarketPrice ?? null,
                    change: q?.regularMarketChange ?? null,
                    changePercent: q?.regularMarketChangePercent ?? null,
                    marketState: q?.marketState ?? "UNKNOWN",
                };
            })
        );
    } catch (err) {
        logger.error("UsMarket", "stocks list failed", { error: err.message });
        res.status(502).json({ error: "Failed to fetch US market data" });
    }
});

router.get("/stock/:symbol/full", auth, async (req, res) => {
    const symbol = String(req.params.symbol || "").toUpperCase();
    if (!US_STOCK_MAP.has(symbol)) return res.status(404).json({ error: "Unknown symbol" });
    const range = VALID_RANGES.includes(req.query.range) ? req.query.range : "1d";

    try {
        const [quotes, chart] = await Promise.all([
            getUsQuotes([symbol]),
            getUsChart(symbol, range),
        ]);
        if (quotes.length === 0) {
            // getUsQuotes degrades a fetch failure to an empty array rather
            // than throwing -- correct for /stocks, where one bad symbol
            // shouldn't fail the other 39. But for a single symbol, no quote
            // means the fetch genuinely failed, not that the stock is
            // legitimately trading at zero. Defaulting price/change to 0
            // here used to render a real ticker as flat at $0.00 with no
            // error shown -- fail loudly instead, same as chart failures
            // already do via the catch block below.
            return res.status(502).json({ error: "Failed to fetch quote data" });
        }
        const q = quotes[0];
        res.json({
            symbol,
            companyName: US_STOCK_MAP.get(symbol).name,
            price: q.regularMarketPrice ?? null,
            change: q.regularMarketChange ?? null,
            changePercent: q.regularMarketChangePercent ?? null,
            marketState: q.marketState ?? "UNKNOWN",
            dayHigh: q.regularMarketDayHigh ?? null,
            dayLow: q.regularMarketDayLow ?? null,
            fiftyTwoWeekHigh: q.fiftyTwoWeekHigh ?? null,
            fiftyTwoWeekLow: q.fiftyTwoWeekLow ?? null,
            marketCap: q.marketCap ?? null,
            chart,
        });
    } catch (err) {
        logger.error("UsMarket", "stock detail failed", { error: err.message, symbol });
        res.status(502).json({ error: "Failed to fetch stock data" });
    }
});

const AGENT_BASE_URL = process.env.US_AGENT_BASE_URL || "http://localhost:8000";
const PREDICT_BASE_URL = process.env.US_AGENT_PREDICT_URL || "http://localhost:8001";
const AGENT_TOKEN = process.env.US_AGENT_TOKEN || "";

const unreachable = (res, service) =>
    res.status(503).json({
        error: `US agent (${service}) is not reachable`,
        detail: "Start it locally with ./us_agent/run_us.sh",
    });

router.get("/positions", auth, async (_req, res) => {
    if (!AGENT_TOKEN) return res.status(500).json({ error: "US_AGENT_TOKEN is not configured" });
    try {
        const upstream = await fetch(`${AGENT_BASE_URL}/api/positions`, {
            headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
            signal: AbortSignal.timeout(10000),
        });
        if (!upstream.ok) {
            const body = await upstream.text();
            return res.status(upstream.status).json({ error: "US agent rejected the request", detail: body });
        }
        res.json(await upstream.json());
    } catch (err) {
        logger.error("UsMarket", "positions proxy failed", { error: err.message });
        unreachable(res, "platform");
    }
});

router.get("/predict/:symbol", auth, async (req, res) => {
    const symbol = String(req.params.symbol || "").toUpperCase();
    if (!/^[A-Z]{1,10}$/.test(symbol)) return res.status(400).json({ error: "invalid symbol" });
    try {
        // predict_service.py's own worst case is higher than it looks:
        // yfinance (~30s) + call_llm (up to two 20s attempts) + a 1.5s
        // retry backoff can add up to ~70s. A 30s timeout here meant this
        // proxy could fail the request while predict_service was still
        // legitimately working -- wasting the LLM call for nothing, since
        // the user already saw an error. 60s covers the realistic worst
        // case; the common case (single-digit seconds, per live testing)
        // is unaffected.
        const upstream = await fetch(`${PREDICT_BASE_URL}/predict/${symbol}`, {
            signal: AbortSignal.timeout(60000),
        });
        if (!upstream.ok) {
            const body = await upstream.text();
            return res.status(upstream.status).json({ error: "prediction failed", detail: body });
        }
        res.json(await upstream.json());
    } catch (err) {
        logger.error("UsMarket", "predict proxy failed", { error: err.message, symbol });
        unreachable(res, "predict service");
    }
});

router.get("/activity", auth, async (req, res) => {
    const limit = Number.isInteger(Number(req.query.limit)) ? Number(req.query.limit) : 20;
    try {
        // 60s, not 10s -- matches /predict's timeout below. Confirmed
        // directly against the deployed predict service: Render's free
        // tier spins it down after inactivity, and a cold start alone can
        // take 30-90s before it answers at all. 10s guaranteed a false
        // "not reachable" on the first request after any idle period.
        const upstream = await fetch(`${PREDICT_BASE_URL}/activity?limit=${encodeURIComponent(limit)}`, {
            signal: AbortSignal.timeout(60000),
        });
        if (!upstream.ok) {
            const body = await upstream.text();
            return res.status(upstream.status).json({ error: "activity fetch failed", detail: body });
        }
        res.json(await upstream.json());
    } catch (err) {
        logger.error("UsMarket", "activity proxy failed", { error: err.message });
        unreachable(res, "predict service");
    }
});

export default router;
