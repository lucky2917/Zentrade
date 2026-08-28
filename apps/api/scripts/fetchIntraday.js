#!/usr/bin/env node
// Usage: node scripts/fetchIntraday.js <outDir> <resolution> <fromDate> <toDate> <symbolsFile|SYMBOL...>
//
// Fetches Fyers intraday candles into a raw cache that the brain parses into
// spine_v2. The brain never talks to Fyers: one client, one rate-limit budget,
// one place for a bug, mirroring how bhavcopy archives already reach it.
//
// Chunking is 100 days because the provider enforces exactly that. A 130-day
// request returns "Invalid input", measured 2026-08-28.
//
// Resumable: a chunk already on disk is never refetched, so a killed run
// resumes where it stopped. Failures are recorded per symbol/resolution/window
// in _failures.json rather than skipped silently.

import { config } from "dotenv";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(scriptDir, "..", ".env") });

const { getHistoricalData, formatDate, CHUNK_LIMIT_DAYS } =
    await import("../src/services/fyers/fyersREST.js");
const { getAccessToken } = await import("../src/services/fyers/fyersAuth.js");
const { getRateLimiter, getRemainingBudget, PER_MINUTE_CAP } =
    await import("../src/services/fyers/rateLimiter.js");
const { default: redis } = await import("../src/config/redis.js");

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 2000;

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

// Fyers answers a range with no listed history with s:"no_data" rather than an
// error. Treating that as a failure would flood the log for every symbol whose
// listing postdates the window, so it is cached as a real empty result.
const classify = (response) => {
    if (response === null || typeof response !== "object") return "blocked";
    if (response.s === "ok") return Array.isArray(response.candles) ? "data" : "malformed";
    if (response.s === "no_data") return "empty";
    return "error";
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const loadSymbols = async (args) => {
    if (args.length === 1 && existsSync(args[0])) {
        const text = await readFile(args[0], "utf8");
        return text.split("\n").map((s) => s.trim()).filter(Boolean)
            .map((s) => (s.includes(":") ? s : `NSE:${s}-EQ`));
    }
    return args;
};

const main = async () => {
    const [outDir, resolution, fromDate, toDate, ...rest] = process.argv.slice(2);
    if (!outDir || !resolution || !fromDate || !toDate || rest.length === 0) {
        console.error("Usage: node scripts/fetchIntraday.js <outDir> <resolution> <from> <to> <symbolsFile|SYMBOL...>");
        process.exitCode = 1;
        return;
    }
    if (!(await getAccessToken())) {
        console.error("No Fyers access token. Run scripts/syncFyersToken.js first.");
        process.exitCode = 1;
        return;
    }

    // MODE_RATES.IDLE throttles to 1 req/s outside market hours, a politeness
    // policy for quiet live-trading periods rather than a provider constraint.
    // PER_MINUTE_CAP is the provider limit, and a one-off bulk backfill should
    // run at it: at 1 req/s the full archive takes long enough that the access
    // token expires mid-run. The reservoir still caps the true rate.
    const perSecond = Math.max(1, Math.floor(PER_MINUTE_CAP / 60));
    await getRateLimiter().updateSettings({
        maxConcurrent: perSecond,
        minTime: Math.ceil(1000 / perSecond),
    });
    console.log(`throttle ${perSecond} req/s (cap ${PER_MINUTE_CAP}/min)`);

    const symbols = await loadSymbols(rest);
    await mkdir(outDir, { recursive: true });
    const limitDays = CHUNK_LIMIT_DAYS[String(resolution)] ?? 100;
    const ranges = chunkRanges(fromDate, toDate, limitDays);
    const planned = symbols.length * ranges.length;

    console.log(`resolution ${resolution}: ${symbols.length} symbols x ${ranges.length} chunks ` +
                `(<=${limitDays}d) = ${planned.toLocaleString()} chunks`);
    console.log(`budget remaining ${(await getRemainingBudget()).toLocaleString()}`);

    const counts = { data: 0, empty: 0, error: 0, blocked: 0, malformed: 0 };
    const failures = [];
    let requests = 0, cached = 0, candles = 0, done = 0;
    const started = Date.now();

    for (const symbol of symbols) {
        for (const [from, to] of ranges) {
            done++;
            const target = path.join(outDir, cacheName(symbol, resolution, from, to));
            if (existsSync(target)) {
                try {
                    candles += JSON.parse(await readFile(target, "utf8")).candles.length;
                    cached++;
                    continue;
                } catch { /* corrupt, refetch below */ }
            }

            let response = await getHistoricalData(symbol, resolution, from, to);
            requests++;
            let outcome = classify(response);

            if (outcome === "blocked" || outcome === "error") {
                await sleep(RETRY_DELAY_MS);
                response = await getHistoricalData(symbol, resolution, from, to);
                requests++;
                outcome = classify(response);
            }

            counts[outcome]++;

            if (outcome === "data" || outcome === "empty") {
                const rows = outcome === "data" ? response.candles : [];
                await writeFile(target, JSON.stringify({
                    symbol, resolution, from, to,
                    fetchedAtUtc: new Date().toISOString(), candles: rows,
                }));
                candles += rows.length;
            } else {
                failures.push({
                    symbol, resolution, from, to, outcome,
                    message: String(response?.message ?? response?.s ?? "no response").slice(0, 200),
                });
            }

            if (done % 200 === 0) {
                const rate = done / ((Date.now() - started) / 1000);
                const eta = Math.round((planned - done) / Math.max(rate, 0.01) / 60);
                console.log(`  ${done}/${planned}  ${(done / planned * 100).toFixed(1)}%  ` +
                            `candles ${candles.toLocaleString()}  fail ${failures.length}  ` +
                            `eta ${eta}m`);
            }
        }
    }

    if (failures.length) {
        const logPath = path.join(outDir, `_failures_${resolution}.json`);
        await writeFile(logPath, JSON.stringify(failures, null, 2));
        console.log(`\n${failures.length} failures written to ${path.basename(logPath)}`);
        for (const f of failures.slice(0, 15)) {
            console.log(`  ${f.symbol} ${f.resolution} ${f.from}..${f.to}  ${f.outcome}: ${f.message}`);
        }
    }

    console.log(`\nresolution ${resolution} done: requests ${requests.toLocaleString()}, ` +
                `from cache ${cached.toLocaleString()}, candles ${candles.toLocaleString()}`);
    console.log(`  outcomes ${JSON.stringify(counts)}`);
    console.log(`  budget remaining ${(await getRemainingBudget()).toLocaleString()}`);
    if (failures.length) process.exitCode = 1;
};

try {
    await main();
} catch (err) {
    console.error("Fetch failed:", err.message);
    process.exitCode = 1;
} finally {
    await redis.quit();
}
