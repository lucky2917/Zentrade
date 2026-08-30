#!/usr/bin/env node
// Manual escape hatch. You should not normally need this.
//
// `npm run preflight` and `npm run agent` both acquire the Fyers token
// themselves, from the Redis named by FYERS_TOKEN_SOURCE_REDIS_URL (or the
// older PROD_REDIS_URL) in apps/api/.env. This script does the same thing on
// demand, for the case where you want to fetch a token without starting
// anything.
//
// The logic lives in src/services/fyers/tokenSource.js so there is one
// implementation rather than two that can drift.
//
// Usage:
//   node scripts/syncFyersToken.js
//   FYERS_TOKEN_SOURCE_REDIS_URL=<source redis> node scripts/syncFyersToken.js
//
// The connection string is read from the environment, never hardcoded and
// never passed as a CLI argument, which would put it in shell history and in
// process listings.

import "dotenv/config";
import redis from "../src/config/redis.js";
import { ensureFyersToken, acquired, STATUS, TOKEN_SOURCE_VARS }
    from "../src/services/fyers/tokenSource.js";

const main = async () => {
    const { status, message } = await ensureFyersToken({ redis });
    process.stdout.write(`${status}: ${message}\n`);

    if (status === STATUS.NO_SOURCE) {
        process.stdout.write(
            `\nSet ${TOKEN_SOURCE_VARS[0]} in apps/api/.env to the Redis of the `
            + "deployment that owns the OAuth callback, and startup will do this "
            + "for you.\n");
    }
    await redis.quit().catch(() => {});
    process.exit(acquired(status) ? 0 : 1);
};

main().catch((err) => {
    process.stderr.write(`Token acquisition failed: ${err.message}\n`);
    process.exit(1);
});
