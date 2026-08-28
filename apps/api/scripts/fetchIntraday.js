#!/usr/bin/env node
// Usage: node scripts/fetchIntraday.js <outDir> <resolution> <fromDate> <toDate> [SYMBOL ...]
//
// Fetches Fyers intraday candles into a raw cache that the brain parses into
// spine_v2. The brain never talks to Fyers: one client, one rate-limit budget,
// one place for a bug, mirroring how bhavcopy archives already reach it.
//
// Chunking is 100 days because the provider enforces exactly that. A 130-day
// request returns "Invalid input", measured 2026-08-28.

import { config } from "dotenv";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(scriptDir, "..", ".env") });

const { getHistoricalData, formatDate, CHUNK_LIMIT_DAYS } =
    await import("../src/services/fyers/fyersREST.js");
const { getAccessToken } = await import("../src/services/fyers/fyersAuth.js");
const { default: redis } = await import("../src/config/redis.js");

const DAY_MS = 24 * 60 * 60 * 1000;

const chunkRanges = (from, to, limitDays) => {
    const ranges = [];
    let start = new Date(from);
    const end = new Date(to);
    while (start <= end) {
        const stop = new Date(Math.min(start.getTime() + (limitDays - 1) * DAY_MS, end.getTime()));
        ranges.push([formatDate(start), formatDate(stop)]);
        start = new Date(stop.getTime() + DAY_MS);
    }
    return ranges;
};

const cacheName = (symbol, resolution, from, to) =>
    `${symbol.replace(/[:\-]/g, "_")}__${resolution}__${from}__${to}.json`;

const main = async () => {
    const [outDir, resolution, fromDate, toDate, ...symbols] = process.argv.slice(2);
    if (!outDir || !resolution || !fromDate || !toDate || symbols.length === 0) {
        console.error("Usage: node scripts/fetchIntraday.js <outDir> <resolution> <from> <to> SYMBOL...");
        process.exitCode = 1;
        return;
    }
    if (!(await getAccessToken())) {
        console.error("No Fyers access token. Run scripts/syncFyersToken.js first.");
        process.exitCode = 1;
        return;
    }

    await mkdir(outDir, { recursive: true });
    const limitDays = CHUNK_LIMIT_DAYS[String(resolution)] ?? 100;
    const ranges = chunkRanges(fromDate, toDate, limitDays);
    console.log(`fetching ${resolution} for ${symbols.length} symbol(s), ` +
                `${ranges.length} chunk(s) of <=${limitDays} days each`);

    let fetched = 0, cached = 0, failed = 0, candles = 0;

    for (const symbol of symbols) {
        for (const [from, to] of ranges) {
            const target = path.join(outDir, cacheName(symbol, resolution, from, to));
            try {
                const existing = JSON.parse(await readFile(target, "utf8"));
                cached++;
                candles += existing.candles.length;
                continue;
            } catch { /* not cached yet */ }

            const response = await getHistoricalData(symbol, resolution, from, to);
            if (response === null || typeof response !== "object" || response.s !== "ok") {
                failed++;
                console.error(`  FAILED ${symbol} ${resolution} ${from}..${to}: ` +
                              `${response === null ? "blocked/exception" : String(response.message ?? response.s).slice(0, 80)}`);
                continue;
            }
            const rows = Array.isArray(response.candles) ? response.candles : [];
            await writeFile(target, JSON.stringify({
                symbol, resolution, from, to, fetchedAtUtc: new Date().toISOString(),
                candles: rows,
            }));
            fetched++;
            candles += rows.length;
        }
        console.log(`  ${symbol}: done`);
    }

    console.log(`\nfetched ${fetched}, from cache ${cached}, failed ${failed}, ` +
                `candles ${candles.toLocaleString()}`);
    if (failed > 0) process.exitCode = 1;
};

try {
    await main();
} catch (err) {
    console.error("Fetch failed:", err.message);
    process.exitCode = 1;
} finally {
    await redis.quit();
}
