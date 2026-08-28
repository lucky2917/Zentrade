import { describe, expect, it } from "vitest";
import Bottleneck from "bottleneck";

// Regression: Bottleneck cancels reservoirRefreshInterval the first time
// updateSettings is called, which applyLimiterSettings does on the first REST
// call of every process. Without a manual refill the reservoir drains once and
// never refills, stalling REST permanently after PER_MINUTE_CAP calls.

const drain = async (limiter, count, timeoutMs) => {
    let done = 0;
    const jobs = [];
    for (let i = 0; i < count; i += 1) {
        jobs.push(limiter.schedule(async () => { done += 1; }));
    }
    await Promise.race([
        Promise.all(jobs),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
    return done;
};

const makeLimiter = (cap, refreshMs) => new Bottleneck({
    reservoir: cap,
    reservoirRefreshAmount: cap,
    reservoirRefreshInterval: refreshMs,
    maxConcurrent: 1,
    minTime: 5,
});

describe("rate limiter reservoir", () => {
    it("stalls after updateSettings without a manual refill", async () => {
        const limiter = makeLimiter(5, 1000);
        await limiter.updateSettings({ maxConcurrent: 3, minTime: 10 });
        const done = await drain(limiter, 8, 3000);
        expect(done).toBe(5);
        expect(await limiter.currentReservoir()).toBe(0);
        limiter.disconnect();
    });

    it("keeps flowing when the reservoir is refilled on our own timer", async () => {
        const limiter = makeLimiter(5, 1000);
        await limiter.updateSettings({ maxConcurrent: 3, minTime: 10 });
        const refill = setInterval(async () => {
            const current = await limiter.currentReservoir();
            if (current !== null && current < 5) await limiter.incrementReservoir(5 - current);
        }, 1000);

        const done = await drain(limiter, 12, 6000);
        clearInterval(refill);
        expect(done).toBe(12);
        limiter.disconnect();
    });

    it("refill never raises the reservoir above the cap", async () => {
        const limiter = makeLimiter(5, 1000);
        await limiter.updateSettings({ maxConcurrent: 3, minTime: 10 });
        const current = await limiter.currentReservoir();
        if (current < 5) await limiter.incrementReservoir(5 - current);
        expect(await limiter.currentReservoir()).toBe(5);
        limiter.disconnect();
    });
});
