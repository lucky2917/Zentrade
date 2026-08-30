import { afterAll, beforeEach, describe, expect, it } from "vitest";

const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;

// One authoritative per-minute ceiling.
//
// Bottleneck's reservoir is per process; the daily budget counter is in Redis.
// Two instances therefore permitted 2 x PER_MINUTE_CAP calls a minute against
// one shared daily budget, and each instance was individually obeying the
// limit it believed in. The ceiling is now a shared counter.

describe.skipIf(!TEST_REDIS)("shared per-minute REST budget", () => {
    let redis, claimMinuteSlot, minuteKeyFor, PER_MINUTE_CAP;

    beforeEach(async () => {
        ({ default: redis } = await import("../config/redis.js"));
        ({ claimMinuteSlot, minuteKeyFor, PER_MINUTE_CAP } =
            await import("../services/fyers/rateLimiter.js"));
        const keys = await redis.keys("fyers:minute:*");
        if (keys.length) await redis.del(...keys);
    });

    afterAll(async () => {
        const keys = await redis.keys("fyers:minute:*");
        if (keys.length) await redis.del(...keys);
    });

    it("allows up to the cap and refuses beyond it", async () => {
        const at = Date.UTC(2026, 7, 31, 4, 30);
        let allowed = 0;
        for (let i = 0; i < PER_MINUTE_CAP + 20; i += 1) {
            if (await claimMinuteSlot(at)) allowed += 1;
        }
        expect(allowed).toBe(PER_MINUTE_CAP);
    });

    // The defect, reproduced: two independent callers standing in for two
    // instances must share one allowance, not get one each.
    it("two instances share one allowance", async () => {
        const at = Date.UTC(2026, 7, 31, 4, 31);
        const cap = 10;
        const instanceA = [];
        const instanceB = [];
        for (let i = 0; i < cap; i += 1) {
            instanceA.push(await claimMinuteSlot(at, cap));
            instanceB.push(await claimMinuteSlot(at, cap));
        }
        const total = [...instanceA, ...instanceB].filter(Boolean).length;
        expect(total).toBe(cap);
    });

    it("gives a new minute a fresh allowance", async () => {
        const minute = Date.UTC(2026, 7, 31, 4, 32);
        const cap = 3;
        for (let i = 0; i < cap; i += 1) await claimMinuteSlot(minute, cap);
        expect(await claimMinuteSlot(minute, cap)).toBe(false);
        expect(await claimMinuteSlot(minute + 60_000, cap)).toBe(true);
    });

    it("counts concurrent claimants exactly once each", async () => {
        const at = Date.UTC(2026, 7, 31, 4, 33);
        const cap = 25;
        const results = await Promise.all(
            Array.from({ length: 100 }, () => claimMinuteSlot(at, cap)));
        expect(results.filter(Boolean)).toHaveLength(cap);
    });

    it("expires the counter so keys do not accumulate", async () => {
        const at = Date.UTC(2026, 7, 31, 4, 34);
        await claimMinuteSlot(at);
        const ttl = await redis.pttl(minuteKeyFor(at));
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(120_000);
    });

    // An unreachable budget is not a licence to spend one.
    it("fails closed when the shared counter cannot be reached", async () => {
        const original = redis.eval;
        redis.eval = async () => { throw new Error("redis down"); };
        try {
            expect(await claimMinuteSlot(Date.now())).toBe(false);
        } finally {
            redis.eval = original;
        }
    });
});
