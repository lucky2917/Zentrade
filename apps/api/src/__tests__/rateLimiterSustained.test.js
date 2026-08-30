import { describe, expect, it } from "vitest";
import Bottleneck from "bottleneck";

// The reservoir bug stalled the shared limiter after exactly PER_MINUTE_CAP
// calls, silently: no error, no log, just a queue that never drained. The live
// Indian agent shares that limiter, so these tests exist to prove a long-lived
// caller keeps making requests past the cap and recovers after exhaustion.
//
// Timings are compressed (cap 5, refill 300ms) so the suite stays fast; the
// production values are 180 per 60s and the mechanism is identical.

const CAP = 5;
const REFILL_MS = 300;

const makeLimiter = () => new Bottleneck({
    reservoir: CAP,
    reservoirRefreshAmount: CAP,
    reservoirRefreshInterval: REFILL_MS,
    maxConcurrent: 1,
    minTime: 1,
});

// Mirrors refillReservoir() in services/fyers/rateLimiter.js
const startRefill = (limiter) => setInterval(async () => {
    const current = await limiter.currentReservoir();
    if (current !== null && current < CAP) await limiter.incrementReservoir(CAP - current);
}, REFILL_MS);

const drain = async (limiter, count, timeoutMs) => {
    let done = 0;
    const jobs = [];
    for (let i = 0; i < count; i += 1) jobs.push(limiter.schedule(async () => { done += 1; }));
    await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, timeoutMs))]);
    return done;
};

describe("sustained request budgeting", () => {
    it("keeps serving well past the reservoir cap", async () => {
        const limiter = makeLimiter();
        await limiter.updateSettings({ maxConcurrent: 2, minTime: 1 });
        const refill = startRefill(limiter);

        const done = await drain(limiter, CAP * 6, 6000);

        clearInterval(refill);
        limiter.disconnect();
        expect(done).toBe(CAP * 6);
    }, 15000);

    it("stalls at exactly the cap without the refill — the original bug", async () => {
        const limiter = makeLimiter();
        await limiter.updateSettings({ maxConcurrent: 2, minTime: 1 });

        const done = await drain(limiter, CAP * 3, 1200);

        limiter.disconnect();
        expect(done).toBe(CAP);
    }, 15000);

    it("serves concurrent callers without starving any of them", async () => {
        const limiter = makeLimiter();
        await limiter.updateSettings({ maxConcurrent: 3, minTime: 1 });
        const refill = startRefill(limiter);

        const served = { a: 0, b: 0, c: 0 };
        const caller = async (key, n) => {
            for (let i = 0; i < n; i += 1) {
                await limiter.schedule(async () => { served[key] += 1; });
            }
        };
        await Promise.race([
            Promise.all([caller("a", 6), caller("b", 6), caller("c", 6)]),
            new Promise((r) => setTimeout(r, 8000)),
        ]);

        clearInterval(refill);
        limiter.disconnect();
        expect(served.a).toBe(6);
        expect(served.b).toBe(6);
        expect(served.c).toBe(6);
    }, 15000);

    it("recovers after full exhaustion instead of staying dead", async () => {
        const limiter = makeLimiter();
        await limiter.updateSettings({ maxConcurrent: 1, minTime: 1 });

        expect(await drain(limiter, CAP, 1000)).toBe(CAP);
        expect(await limiter.currentReservoir()).toBe(0);

        const refill = startRefill(limiter);
        const after = await drain(limiter, CAP, 3000);
        clearInterval(refill);
        limiter.disconnect();

        expect(after).toBe(CAP);
    }, 15000);

    it("never lets the reservoir exceed the cap", async () => {
        const limiter = makeLimiter();
        const refill = startRefill(limiter);
        await new Promise((r) => setTimeout(r, REFILL_MS * 4));
        const level = await limiter.currentReservoir();
        clearInterval(refill);
        limiter.disconnect();
        expect(level).toBeLessThanOrEqual(CAP);
    }, 15000);
});
