#!/usr/bin/env node
// Usage: node scripts/probeFyersDepth.js [SYMBOL ...]
//
// M18 step 1. Measures how far back Fyers actually serves history for each
// resolution the spine ingests. That depth is the ceiling on every model
// trained above it, and it decides whether a paid vendor is needed at all,
// so it is measured once rather than assumed.
//
// Costs roughly a dozen calls per symbol/resolution pair against the shared
// daily budget, and routes through fyersREST so the rate limiter and budget
// counter see it like any other traffic.

import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(scriptDir, "..", ".env") });

const { getHistoricalData } = await import("../src/services/fyers/fyersREST.js");
const { getAccessToken } = await import("../src/services/fyers/fyersAuth.js");
const { default: redis } = await import("../src/config/redis.js");

const RESOLUTIONS = [
    { id: "D", label: "daily", chunkDays: 366 },
    { id: "1", label: "1-minute", chunkDays: 100 },
];
const PROBE_WINDOW_DAYS = 15;
const MAX_YEARS_BACK = 32;
const BINARY_SEARCH_PRECISION_DAYS = 20;
const DEFAULT_SYMBOLS = ["NSE:RELIANCE-EQ", "NSE:TCS-EQ"];

const DAY_MS = 24 * 60 * 60 * 1000;
const formatDate = (d) => d.toISOString().slice(0, 10);
const daysBefore = (from, n) => new Date(from.getTime() - n * DAY_MS);

const hasDataAt = async (symbol, resolution, endDate) => {
    const response = await getHistoricalData(
        symbol,
        resolution,
        formatDate(daysBefore(endDate, PROBE_WINDOW_DAYS)),
        formatDate(endDate)
    );
    return Boolean(response?.candles?.length);
};

// Expand backwards in doubling steps to bracket the boundary, then bisect.
// Cheaper than a linear walk and makes no assumption about the real depth.
const findEarliest = async (symbol, resolution) => {
    const now = new Date();
    let calls = 0;

    let goodDays = null;
    let badDays = null;

    for (let years = 1; years <= MAX_YEARS_BACK; years *= 2) {
        const days = Math.round(years * 365.25);
        calls++;
        if (await hasDataAt(symbol, resolution, daysBefore(now, days))) {
            goodDays = days;
        } else {
            badDays = days;
            break;
        }
    }

    if (goodDays === null) return { earliest: null, calls };
    if (badDays === null) return { earliest: daysBefore(now, goodDays), calls, atLimit: true };

    while (badDays - goodDays > BINARY_SEARCH_PRECISION_DAYS) {
        const midpoint = Math.floor((goodDays + badDays) / 2);
        calls++;
        if (await hasDataAt(symbol, resolution, daysBefore(now, midpoint))) {
            goodDays = midpoint;
        } else {
            badDays = midpoint;
        }
    }

    return { earliest: daysBefore(now, goodDays), calls, years: goodDays / 365.25 };
};

const backfillCost = (years, chunkDays, symbolCount) =>
    (Math.floor((years * 365.25) / chunkDays) + 1) * symbolCount;

const main = async () => {
    if (!(await getAccessToken())) {
        console.error(
            "No Fyers access token in Redis.\n" +
            "Fyers pins its OAuth redirect to production, so local dev cannot mint one:\n" +
            "  PROD_REDIS_URL=<render redis url> node scripts/syncFyersToken.js"
        );
        process.exitCode = 1;
        return;
    }

    const symbols = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SYMBOLS;
    console.log(`Probing Fyers history depth for ${symbols.length} symbol(s)\n`);

    let totalCalls = 0;
    const depths = new Map();

    for (const resolution of RESOLUTIONS) {
        for (const symbol of symbols) {
            const { earliest, calls, years, atLimit } = await findEarliest(symbol, resolution.id);
            totalCalls += calls;

            if (!earliest) {
                console.log(`  ${resolution.label.padEnd(9)} ${symbol.padEnd(18)} NO DATA (${calls} calls)`);
                continue;
            }

            const span = atLimit ? `>= ${MAX_YEARS_BACK}` : years.toFixed(1);
            console.log(
                `  ${resolution.label.padEnd(9)} ${symbol.padEnd(18)} back to ${formatDate(earliest)}` +
                `  (~${span} yr, ${calls} calls)`
            );

            const known = depths.get(resolution.id);
            if (known === undefined || (years ?? MAX_YEARS_BACK) < known) {
                depths.set(resolution.id, years ?? MAX_YEARS_BACK);
            }
        }
    }

    console.log(`\nProbe cost: ${totalCalls} calls.\n`);
    console.log("Estimated full backfill for a 200-symbol universe:");
    let projected = 0;
    for (const resolution of RESOLUTIONS) {
        const years = depths.get(resolution.id);
        if (years === undefined) continue;
        const calls = backfillCost(years, resolution.chunkDays, 200);
        projected += calls;
        console.log(`  ${resolution.label.padEnd(9)} ${String(calls).padStart(7)} calls for ~${years.toFixed(1)} yr`);
    }
    console.log(`  ${"total".padEnd(9)} ${String(projected).padStart(7)} calls of the 100,000/day budget`);
};

try {
    await main();
} catch (err) {
    console.error("Probe failed:", err.message);
    process.exitCode = 1;
} finally {
    await redis.quit();
}
