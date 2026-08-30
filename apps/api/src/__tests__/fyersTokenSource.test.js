import { describe, expect, it, vi } from "vitest";
import { ensureFyersToken, acquired, tokenSourceUrl, mintsItsOwnToken,
         STATUS, TOKEN_SOURCE_VARS } from "../services/fyers/tokenSource.js";

// Getting a Fyers token onto the machine that is running.
//
// Fyers registers one OAuth redirect URI per app. When it points at the hosted
// backend, the token is minted there and written to that deployment's Redis —
// so a developer machine has no token and never will, however many times the
// operator re-authenticates. Startup fetches it instead of the operator
// remembering a command once a day at the one moment they are busy.

const fakeRedis = (state = {}) => ({
    store: state,
    get: vi.fn(async (k) => state[k] ?? null),
    ttl: vi.fn(async (k) => (state[k] ? (state[`${k}:ttl`] ?? 3600) : -2)),
    set: vi.fn(async (k, v, mode, ttl) => {
        state[k] = v;
        if (mode === "EX") state[`${k}:ttl`] = ttl;
        return "OK";
    }),
});

const sourceFactory = (client, { failConnect = false } = {}) =>
    function FakeRedis() {
        return {
            ...client,
            connect: vi.fn(async () => {
                if (failConnect) {
                    const err = new Error("connect ECONNREFUSED");
                    err.code = "ECONNREFUSED";
                    throw err;
                }
            }),
            disconnect: vi.fn(),
        };
    };

const env = (over = {}) => ({
    REDIS_URL: "redis://localhost:6379",
    FYERS_REDIRECT_URI: "https://hosted.example.com/fyers/callback",
    FRONTEND_URL: "https://app.example.com",
    ...over,
});

describe("a token already here is left alone", () => {
    it("does not reach for a source when one is live", async () => {
        const local = fakeRedis({ "fyers:access_token": "t", "fyers:access_token:ttl": 7200 });
        const RedisClient = sourceFactory(fakeRedis());
        const result = await ensureFyersToken({
            redis: local, env: env({ FYERS_TOKEN_SOURCE_REDIS_URL: "redis://source:6379" }),
            RedisClient });

        expect(result.status).toBe(STATUS.PRESENT);
        expect(result.message).toMatch(/valid for 2h 0m/);
        expect(acquired(result.status)).toBe(true);
    });

    it("treats an expired token as absent", async () => {
        const local = fakeRedis({ "fyers:access_token": "t", "fyers:access_token:ttl": 0 });
        const result = await ensureFyersToken({ redis: local, env: env() });
        expect(result.status).toBe(STATUS.NO_SOURCE);
    });
});

describe("fetching from the deployment that owns the callback", () => {
    it("copies the token and preserves the real remaining life", async () => {
        const local = fakeRedis();
        const source = fakeRedis({
            "fyers:access_token": "the-token", "fyers:access_token:ttl": 5400,
            "fyers:token_expiry": "1788000000000",
        });
        const result = await ensureFyersToken({
            redis: local, RedisClient: sourceFactory(source),
            env: env({ FYERS_TOKEN_SOURCE_REDIS_URL: "redis://source:6379" }) });

        expect(result.status).toBe(STATUS.SYNCED);
        expect(local.store["fyers:access_token"]).toBe("the-token");
        // A borrowed token must expire when the original does, not outlive it.
        expect(local.store["fyers:access_token:ttl"]).toBe(5400);
        expect(local.store["fyers:token_expiry"]).toBe("1788000000000");
    });

    // Merging a developer's Redis into a deployment's, or the reverse, would
    // move price caches, rate-limit budgets and the market-data ownership
    // lease. Only the two auth keys move.
    it("moves the two auth keys and nothing else", async () => {
        const local = fakeRedis();
        const source = fakeRedis({
            "fyers:access_token": "t", "fyers:access_token:ttl": 600,
            "fyers:token_expiry": "1", "fyers:calls_used_today": "5000",
            "stock:RELIANCE": "{}", "zentrade:marketdata:owner": "someone-else",
        });
        await ensureFyersToken({
            redis: local, RedisClient: sourceFactory(source),
            env: env({ FYERS_TOKEN_SOURCE_REDIS_URL: "redis://source:6379" }) });

        expect(Object.keys(local.store).sort())
            .toEqual(["fyers:access_token", "fyers:access_token:ttl", "fyers:token_expiry"]);
    });

    it("refuses to sync a Redis onto itself", async () => {
        const local = fakeRedis();
        const result = await ensureFyersToken({
            redis: local, RedisClient: sourceFactory(fakeRedis()),
            env: env({ FYERS_TOKEN_SOURCE_REDIS_URL: "redis://localhost:6379" }) });
        expect(result.status).toBe(STATUS.SAME_REDIS);
    });

    it("reports a source that has no live token either", async () => {
        const result = await ensureFyersToken({
            redis: fakeRedis(), RedisClient: sourceFactory(fakeRedis()),
            env: env({ FYERS_TOKEN_SOURCE_REDIS_URL: "redis://source:6379" }) });
        expect(result.status).toBe(STATUS.SOURCE_EMPTY);
        expect(result.message).toMatch(/re-authenticate first/);
    });

    it("reports an unreachable source without failing the caller", async () => {
        const result = await ensureFyersToken({
            redis: fakeRedis(),
            RedisClient: sourceFactory(fakeRedis(), { failConnect: true }),
            env: env({ FYERS_TOKEN_SOURCE_REDIS_URL: "redis://source:6379" }) });
        expect(result.status).toBe(STATUS.FAILED);
        expect(result.message).toMatch(/ECONNREFUSED/);
    });

    it("accepts the older variable name as well as the current one", () => {
        expect(TOKEN_SOURCE_VARS).toEqual(
            ["FYERS_TOKEN_SOURCE_REDIS_URL", "PROD_REDIS_URL"]);
        expect(tokenSourceUrl({ PROD_REDIS_URL: "redis://old:6379" })).toBe("redis://old:6379");
        // The current name wins when both are set.
        expect(tokenSourceUrl({ PROD_REDIS_URL: "redis://old:6379",
                                FYERS_TOKEN_SOURCE_REDIS_URL: "redis://new:6379" }))
            .toBe("redis://new:6379");
    });
});

describe("the message tells the operator what is actually wrong", () => {
    // The old message said "re-authenticate at /reauth" to an operator who had
    // just done exactly that. It named the wrong problem.
    it("names the deployment that holds the token, not the login page", async () => {
        const result = await ensureFyersToken({ redis: fakeRedis(), env: env() });
        expect(result.status).toBe(STATUS.NO_SOURCE);
        expect(result.message).toMatch(/hosted\.example\.com/);
        expect(result.message).toMatch(/FYERS_TOKEN_SOURCE_REDIS_URL/);
        expect(result.message).not.toMatch(/re-authenticate at/);
    });

    it("says to log in when this backend does own the callback", async () => {
        const result = await ensureFyersToken({
            redis: fakeRedis(),
            env: env({ FYERS_REDIRECT_URI: "http://localhost:5000/fyers/callback" }) });
        expect(result.status).toBe(STATUS.LOCAL_MINT);
        expect(result.message).toMatch(/authenticate at https:\/\/app\.example\.com\/reauth/);
    });

    it("recognises every local host form", () => {
        for (const uri of ["http://localhost:5000/cb", "http://127.0.0.1:5000/cb",
                           "http://[::1]:5000/cb"]) {
            expect({ uri, local: mintsItsOwnToken(uri) }).toEqual({ uri, local: true });
        }
        expect(mintsItsOwnToken("https://zentrade-server.onrender.com/fyers/callback")).toBe(false);
        expect(mintsItsOwnToken(undefined)).toBe(false);
        expect(mintsItsOwnToken("not a url")).toBe(false);
    });
});

describe("no secret ever leaves this module", () => {
    it("returns no connection string and no token in any outcome", async () => {
        const SECRET_URL = "redis://user:hunter2@source.example.com:6379";
        const TOKEN = "eyJhbGciOiJI.super.secret";
        const cases = await Promise.all([
            ensureFyersToken({ redis: fakeRedis(), env: env() }),
            ensureFyersToken({ redis: fakeRedis(),
                RedisClient: sourceFactory(fakeRedis(), { failConnect: true }),
                env: env({ FYERS_TOKEN_SOURCE_REDIS_URL: SECRET_URL }) }),
            ensureFyersToken({ redis: fakeRedis(),
                RedisClient: sourceFactory(fakeRedis({
                    "fyers:access_token": TOKEN, "fyers:access_token:ttl": 600 })),
                env: env({ FYERS_TOKEN_SOURCE_REDIS_URL: SECRET_URL }) }),
        ]);
        for (const { message } of cases) {
            expect(message).not.toContain("hunter2");
            expect(message).not.toContain(TOKEN);
            expect(message).not.toContain(SECRET_URL);
        }
    });

    it("logs a duration, never the token", async () => {
        const logger = { info: vi.fn() };
        await ensureFyersToken({
            redis: fakeRedis(), logger,
            RedisClient: sourceFactory(fakeRedis({
                "fyers:access_token": "secret-token", "fyers:access_token:ttl": 600 })),
            env: env({ FYERS_TOKEN_SOURCE_REDIS_URL: "redis://source:6379" }) });

        const logged = JSON.stringify(logger.info.mock.calls);
        expect(logged).not.toContain("secret-token");
        expect(logged).toMatch(/validForMinutes/);
    });
});

describe("one implementation, not two", () => {
    it("the standalone script delegates rather than duplicating the logic", async () => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const source = readFileSync(
            join(process.cwd(), "scripts/syncFyersToken.js"), "utf8");
        expect(source).toMatch(/ensureFyersToken/);
        // It must not re-open its own connections or re-read .env by hand.
        expect(source).not.toMatch(/new Redis\(/);
        expect(source).not.toMatch(/readFileSync/);
    });

    it("startup acquires the token rather than only inspecting it", async () => {
        const { readFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        for (const file of ["scripts/preflight.js", "scripts/agent.mjs", "src/index.js"]) {
            const source = readFileSync(join(process.cwd(), file), "utf8");
            expect({ file, acquires: /ensureFyersToken/.test(source) })
                .toEqual({ file, acquires: true });
        }
    });
});
