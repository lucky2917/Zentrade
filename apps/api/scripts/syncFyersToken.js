#!/usr/bin/env node
// Usage: PROD_REDIS_URL=<production redis connection string> node scripts/syncFyersToken.js
//
// Copies just the two Fyers auth keys (access_token, token_expiry) from
// production Redis into local dev Redis, preserving the real remaining
// TTL. Fyers' OAuth redirect_uri is fixed to production, so local dev
// can never mint its own token directly -- this borrows production's
// without merging the rest of local dev's Redis (chart cache, price
// cache, rate-limit budget counters) into production's.
//
// PROD_REDIS_URL is read from the environment at run time, never
// hardcoded here and never passed as a plain CLI arg (shows up in shell
// history / process lists otherwise). Run this from wherever you can
// actually reach production Redis -- a Render Shell session, or your
// own machine if Render exposes an external connection string.
//
// Local Redis is read from apps/api/.env's REDIS_URL, same as the app.

import Redis from "ioredis";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ACCESS_TOKEN_KEY = "fyers:access_token";
const TOKEN_EXPIRY_KEY = "fyers:token_expiry";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(scriptDir, "..", ".env");

const readLocalRedisUrl = () => {
    const envText = readFileSync(envPath, "utf8");
    const match = envText.match(/^REDIS_URL=(.+)$/m);
    if (!match) throw new Error(`REDIS_URL not found in ${envPath}`);
    return match[1].trim();
};

const main = async () => {
    const prodUrl = process.env.PROD_REDIS_URL;
    if (!prodUrl) {
        console.error("Set PROD_REDIS_URL to production's Redis connection string and re-run.");
        console.error("Example: PROD_REDIS_URL=redis://... node scripts/syncFyersToken.js");
        process.exit(1);
    }

    const localUrl = readLocalRedisUrl();
    if (localUrl === prodUrl) {
        console.error("Local REDIS_URL matches PROD_REDIS_URL -- refusing to sync a Redis onto itself.");
        process.exit(1);
    }

    const prod = new Redis(prodUrl, { lazyConnect: true, connectTimeout: 10_000 });
    const local = new Redis(localUrl, { lazyConnect: true, connectTimeout: 10_000 });

    try {
        await prod.connect();
        await local.connect();

        const [token, expiry, ttl] = await Promise.all([
            prod.get(ACCESS_TOKEN_KEY),
            prod.get(TOKEN_EXPIRY_KEY),
            prod.ttl(ACCESS_TOKEN_KEY),
        ]);

        if (!token || ttl <= 0) {
            console.error("Production has no live Fyers token right now (nothing to copy). Reauth in production first.");
            process.exit(1);
        }

        await local.set(ACCESS_TOKEN_KEY, token, "EX", ttl);
        if (expiry) await local.set(TOKEN_EXPIRY_KEY, expiry);

        console.log(`Synced Fyers token to local Redis. Valid for another ${Math.round(ttl / 60)} minutes.`);
    } finally {
        prod.disconnect();
        local.disconnect();
    }
};

main().catch((err) => {
    console.error("Sync failed:", err.message);
    process.exit(1);
});
