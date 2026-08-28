#!/usr/bin/env node
// Usage: node scripts/probeFyersDepth.js [SYMBOL ...]
//
// Measures how deep the Fyers intraday archive actually goes, and separates a
// provider limit from an adapter limit. Diagnostic only: it downloads nothing
// beyond its probe windows and writes nothing to disk.
//
// It calls getHistoricalData directly rather than getCandles. getCandles
// chunks, parallelises and flattens every outcome to an array, so an errored
// chunk there is indistinguishable from the edge of the archive and would
// understate history rather than report a failure.

import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(scriptDir, "..", ".env") });

const { getHistoricalData, formatDate, CHUNK_LIMIT_DAYS } =
    await import("../src/services/fyers/fyersREST.js");
const { getAccessToken } = await import("../src/services/fyers/fyersAuth.js");
const { default: redis } = await import("../src/config/redis.js");

const SESSION_MINUTES = 375;                 // NSE 09:15 to 15:30
const SESSION_OPEN_MIN = 9 * 60 + 15;
const SESSION_CLOSE_MIN = 15 * 60 + 30;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const PROBE_WINDOW_DAYS = 5;

const RESOLUTIONS = [
    { id: "1", label: "1-minute", minutes: 1 },
    { id: "5", label: "5-minute", minutes: 5 },
    { id: "15", label: "15-minute", minutes: 15 },
];
const DEFAULT_SYMBOLS = ["NSE:RELIANCE-EQ", "NSE:TCS-EQ", "NSE:SBIN-EQ"];

let calls = 0;
const daysBefore = (from, n) => new Date(from.getTime() - n * DAY_MS);

const ist = (epochSeconds) => {
    const d = new Date(epochSeconds * 1000 + IST_OFFSET_MS);
    return {
        date: d.toISOString().slice(0, 10),
        minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
        stamp: d.toISOString().slice(0, 16).replace("T", " "),
    };
};

const fetchWindow = async (symbol, resolution, endDate, days = PROBE_WINDOW_DAYS) => {
    calls++;
    const response = await getHistoricalData(
        symbol, resolution, formatDate(daysBefore(endDate, days)), formatDate(endDate));

    if (response === null) return { outcome: "blocked", candles: [] };
    if (typeof response !== "object") return { outcome: "malformed", candles: [] };
    if (response.s !== "ok") {
        return { outcome: "error", code: response.code ?? null,
                 message: String(response.message ?? "").slice(0, 100), candles: [] };
    }
    const candles = Array.isArray(response.candles) ? response.candles : [];
    return { outcome: candles.length ? "data" : "empty", candles };
};

/** Ordering, duplicates, session sanity, and per-session completeness. */
const inspect = (candles, resolutionMinutes) => {
    if (!candles.length) return null;
    const times = candles.map((c) => c[0]);

    let ordered = true;
    let duplicates = 0;
    const seen = new Set();
    for (let i = 0; i < times.length; i++) {
        if (i > 0 && times[i] <= times[i - 1]) ordered = false;
        if (seen.has(times[i])) duplicates++;
        seen.add(times[i]);
    }

    const perSession = new Map();
    let outsideSession = 0;
    for (const t of times) {
        const { date, minutes } = ist(t);
        perSession.set(date, (perSession.get(date) ?? 0) + 1);
        if (minutes < SESSION_OPEN_MIN || minutes > SESSION_CLOSE_MIN) outsideSession++;
    }

    const expectedPerSession = Math.floor(SESSION_MINUTES / resolutionMinutes);
    const short = [...perSession.entries()].filter(([, n]) => n < expectedPerSession * 0.9);

    return {
        count: times.length,
        firstIst: ist(times[0]).stamp,
        lastIst: ist(times[times.length - 1]).stamp,
        sessions: perSession.size,
        expectedPerSession,
        medianPerSession: [...perSession.values()].sort((a, b) => a - b)[Math.floor(perSession.size / 2)],
        shortSessions: short.length,
        ordered, duplicates, outsideSession,
    };
};

const findOldest = async (symbol, resolution) => {
    const now = new Date();
    let good = null;
    let bad = null;

    for (const years of [0.02, 0.25, 1, 2, 3, 5, 8]) {
        const days = Math.round(years * 365.25);
        const result = await fetchWindow(symbol, resolution, daysBefore(now, days));
        if (result.outcome === "data") { good = days; continue; }
        if (result.outcome === "error" || result.outcome === "blocked") {
            return { edge: good, halted: result };
        }
        bad = days;
        break;
    }
    if (good === null) return { edge: null, halted: { outcome: "no data even in recent history" } };
    if (bad === null) return { edge: good, atLimit: true };

    while (bad - good > 20) {
        const mid = Math.floor((good + bad) / 2);
        const result = await fetchWindow(symbol, resolution, daysBefore(now, mid));
        if (result.outcome === "data") good = mid;
        else if (result.outcome === "error" || result.outcome === "blocked") {
            return { edge: good, degraded: result };
        } else bad = mid;
    }
    return { edge: good, years: good / 365.25 };
};

const main = async () => {
    if (!(await getAccessToken())) {
        console.error(
            "No Fyers access token in Redis.\n" +
            "Fyers pins its OAuth redirect to production, so local dev cannot mint one:\n" +
            "  PROD_REDIS_URL=<render redis url> node scripts/syncFyersToken.js\n" +
            "Production Redis runs persistence=off with allkeys_lru, so an idle token\n" +
            "can be evicted there too and may need re-minting through the OAuth flow.");
        process.exitCode = 1;
        return;
    }

    const symbols = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SYMBOLS;
    console.log(`Fyers intraday depth probe`);
    console.log(`  symbols ${symbols.length}, resolutions ${RESOLUTIONS.length}, window ${PROBE_WINDOW_DAYS} days\n`);

    const rows = [];
    for (const resolution of RESOLUTIONS) {
        for (const symbol of symbols) {
            const before = calls;
            const found = await findOldest(symbol, resolution.id);

            if (found.edge === null) {
                console.log(`  ${resolution.label.padEnd(10)} ${symbol.padEnd(18)} HALTED ${JSON.stringify(found.halted)}`);
                rows.push({ symbol, timeframe: resolution.label, halted: found.halted });
                continue;
            }

            const now = new Date();
            const oldest = await fetchWindow(symbol, resolution.id, daysBefore(now, found.edge));
            const newest = await fetchWindow(symbol, resolution.id, now);
            const o = inspect(oldest.candles, resolution.minutes);
            const n = inspect(newest.candles, resolution.minutes);
            const span = found.atLimit ? ">=8.00" : (found.years ?? 0).toFixed(2);

            console.log(`  ${resolution.label.padEnd(10)} ${symbol.padEnd(18)} ~${span} yr` +
                        `  (${calls - before} calls)` + (found.degraded ? "  [halted early]" : ""));
            if (o) {
                console.log(`      oldest window ${o.firstIst} .. ${o.lastIst}`);
                console.log(`        ${o.count} candles, ${o.sessions} sessions, median ${o.medianPerSession}/session` +
                            ` (expected ${o.expectedPerSession}), short ${o.shortSessions},` +
                            ` ordered=${o.ordered}, dupes=${o.duplicates}, outside-session=${o.outsideSession}`);
            }
            if (n) console.log(`      newest window ${n.firstIst} .. ${n.lastIst}, ${n.count} candles`);
            rows.push({ symbol, timeframe: resolution.label, span,
                        oldest: o?.firstIst, newest: n?.lastIst, o, n });
        }
    }

    console.log("\n=== is the limit days, candle count, or both? ===");
    console.log(`  adapter asserts CHUNK_LIMIT_DAYS=${CHUNK_LIMIT_DAYS["1"]} for intraday.`);
    const probe = symbols[0];
    for (const days of [100, 130, 200]) {
        const line = [];
        for (const resolution of RESOLUTIONS) {
            const result = await fetchWindow(probe, resolution.id, new Date(), days);
            const shape = inspect(result.candles, resolution.minutes);
            line.push(`${resolution.label}=${result.outcome}${shape ? `/${shape.count}c/${shape.sessions}s` : ""}`);
        }
        console.log(`  ${String(days).padStart(3)} days: ${line.join("  ")}`);
    }
    console.log("  Same days succeeding at 15m but failing or truncating at 1m means the");
    console.log("  provider caps CANDLES. All three behaving alike means it caps DAYS.");
    console.log("  Any request beyond 100 days succeeding means the 100 is ours, not theirs.");

    console.log(`\nTotal calls: ${calls}`);
    console.log("\nSUMMARY");
    console.log("symbol,timeframe,oldest_ist,newest_ist,years,continuity,ordered,duplicates");
    for (const r of rows) {
        const continuity = r.o
            ? (r.o.shortSessions === 0 ? "continuous" : `partial(${r.o.shortSessions} short)`)
            : "unavailable";
        console.log([r.symbol, r.timeframe, r.oldest ?? "", r.newest ?? "", r.span ?? "",
                     continuity, r.o?.ordered ?? "", r.o?.duplicates ?? ""].join(","));
    }
};

try {
    await main();
} catch (err) {
    console.error("Probe failed:", err.message);
    process.exitCode = 1;
} finally {
    await redis.quit();
}
