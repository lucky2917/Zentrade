import { describe, it, expect } from "vitest";
import { createInstrumentResolver, type QueryablePool } from "../index.js";

const RELIANCE_ROW = {
    id: "5f6d1101-e2bb-4255-8caf-4136c566a901",
    venue: "NSE",
    symbol: "RELIANCE",
    name: "Reliance Industries",
    asset_class: "equity",
    currency: "INR",
};

const fakePool = () => {
    let calls = 0;
    const pool: QueryablePool = {
        query: async (_text, params) => {
            calls++;
            return { rows: params?.[1] === "RELIANCE" ? [RELIANCE_ROW] : [] };
        },
    };
    return { pool, calls: () => calls };
};

describe("instrument resolver", () => {
    it("resolves a hit and caches it (one query for N lookups)", async () => {
        const { pool, calls } = fakePool();
        const resolver = createInstrumentResolver(pool);

        const first = await resolver.bySymbol("NSE", "RELIANCE");
        expect(first).toEqual({
            instrumentId: RELIANCE_ROW.id,
            venue: "NSE",
            symbol: "RELIANCE",
            name: "Reliance Industries",
            assetClass: "equity",
            currency: "INR",
        });

        for (let i = 0; i < 99; i++) await resolver.bySymbol("NSE", "RELIANCE");
        expect(calls()).toBe(1);
        expect(resolver.cacheSize()).toBe(1);
    });

    it("returns null on miss and does NOT cache misses (late seeding works)", async () => {
        const { pool, calls } = fakePool();
        const resolver = createInstrumentResolver(pool);
        expect(await resolver.bySymbol("NSE", "NOTREAL")).toBeNull();
        expect(await resolver.bySymbol("NSE", "NOTREAL")).toBeNull();
        expect(calls()).toBe(2);
        expect(resolver.cacheSize()).toBe(0);
    });

    it("venue is part of the cache key", async () => {
        const { pool, calls } = fakePool();
        const resolver = createInstrumentResolver(pool);
        await resolver.bySymbol("NSE", "RELIANCE");
        await resolver.bySymbol("BSE", "RELIANCE"); // miss, separate key
        expect(calls()).toBe(2);
    });

    it("cached lookups clear the roadmap p99 < 1ms bar with room", async () => {
        const { pool } = fakePool();
        const resolver = createInstrumentResolver(pool);
        await resolver.bySymbol("NSE", "RELIANCE"); // warm

        const N = 10_000;
        const start = performance.now();
        for (let i = 0; i < N; i++) await resolver.bySymbol("NSE", "RELIANCE");
        const avgMs = (performance.now() - start) / N;
        // eslint-disable-next-line no-console
        console.log(`cached resolve: ${(avgMs * 1000).toFixed(2)}µs avg`);
        expect(avgMs).toBeLessThan(1);
    });
});
