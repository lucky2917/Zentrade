import { describe, expect, it, beforeEach, vi } from "vitest";
import {
    BarAggregator, applyTick, rollUp, bucketStartMinute, bucketTimestamp,
    isTradableMinute, lastBarStartMinute, istMinutesOf, SESSION_OPEN_IST, SESSION_CLOSE_IST,
} from "../services/fyers/barAggregator.js";

// IST -> epoch ms on 2026-09-01 (a Tuesday).
const at = (h, m, s = 0) => Date.UTC(2026, 8, 1, 0, h * 60 + m - 330, s);

describe("session boundaries match the frozen spine rule", () => {
    it("the last valid bar START is close minus the interval", () => {
        expect(lastBarStartMinute("1m")).toBe(15 * 60 + 29);
        expect(lastBarStartMinute("5m")).toBe(15 * 60 + 25);
        expect(lastBarStartMinute("15m")).toBe(15 * 60 + 15);
    });

    it("15:30 is NOT a valid 1m trading bar", () => {
        expect(isTradableMinute(at(15, 29), "1m")).toBe(true);
        expect(isTradableMinute(at(15, 30), "1m")).toBe(false);
        expect(isTradableMinute(at(15, 31), "1m")).toBe(false);
    });

    it("rejects ticks before the opening bell", () => {
        expect(isTradableMinute(at(9, 14), "1m")).toBe(false);
        expect(isTradableMinute(at(9, 15), "1m")).toBe(true);
    });

    it("computes IST minutes explicitly, not from machine locale", () => {
        expect(istMinutesOf(at(9, 15))).toBe(SESSION_OPEN_IST);
        expect(istMinutesOf(at(15, 30))).toBe(SESSION_CLOSE_IST);
    });
});

describe("bucketing", () => {
    it("floors to the bucket start, anchored on the open", () => {
        expect(bucketStartMinute(at(9, 17, 45), "1m")).toBe(9 * 60 + 17);
        expect(bucketStartMinute(at(9, 17), "5m")).toBe(9 * 60 + 15);
        expect(bucketStartMinute(at(9, 22), "5m")).toBe(9 * 60 + 20);
        expect(bucketStartMinute(at(9, 44), "15m")).toBe(9 * 60 + 30);
    });

    it("returns null before the session", () => {
        expect(bucketStartMinute(at(9, 0), "1m")).toBeNull();
    });

    it("produces a deterministic UTC timestamp", () => {
        expect(bucketTimestamp(at(10, 0, 30), "1m")).toBe("2026-09-01T04:30:00.000Z");
        expect(bucketTimestamp(at(10, 3), "5m")).toBe("2026-09-01T04:30:00.000Z");
    });
});

describe("tick accumulation", () => {
    const tick = (price, cumulativeVolume, atMs) => ({
        ts: "2026-09-01T04:30:00.000Z", price, cumulativeVolume, at: atMs });

    it("opens a bar on the first tick", () => {
        const bar = applyTick(null, tick(100, 5000, 1));
        expect(bar).toMatchObject({ open: 100, high: 100, low: 100, close: 100, volume: 0, ticks: 1 });
    });

    it("tracks high, low and close", () => {
        let bar = applyTick(null, tick(100, 5000, 1));
        bar = applyTick(bar, tick(105, 5100, 2));
        bar = applyTick(bar, tick(98, 5200, 3));
        expect(bar).toMatchObject({ open: 100, high: 105, low: 98, close: 98 });
    });

    it("derives volume as a DELTA of cumulative day volume", () => {
        let bar = applyTick(null, tick(100, 5000, 1));
        bar = applyTick(bar, tick(101, 5350, 2));
        expect(bar.volume).toBe(350);   // not 5350, and not 10350
    });

    it("never produces negative volume from a resetting counter", () => {
        let bar = applyTick(null, tick(100, 5000, 1));
        bar = applyTick(bar, tick(101, 10, 2));
        expect(bar.volume).toBe(0);
    });

    it("ignores an out-of-order tick rather than rewriting the close", () => {
        let bar = applyTick(null, tick(100, 5000, 10));
        bar = applyTick(bar, tick(999, 6000, 5));    // older
        expect(bar.close).toBe(100);
        expect(bar.ticks).toBe(1);
    });

    it("ignores a malformed price", () => {
        let bar = applyTick(null, tick(100, 5000, 1));
        bar = applyTick(bar, { ...tick(NaN, 5100, 2) });
        expect(bar.close).toBe(100);
    });
});

describe("roll-up derives 5m and 15m from 1m", () => {
    const bars1m = Array.from({ length: 15 }, (_, i) => ({
        ts: bucketTimestamp(at(9, 15 + i), "1m"),
        open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10, ticks: 2,
    }));

    it("groups 1m into 5m buckets with correct OHLCV", () => {
        const rolled = rollUp(bars1m, "5m");
        expect(rolled).toHaveLength(3);
        expect(rolled[0].open).toBe(bars1m[0].open);
        expect(rolled[0].close).toBe(bars1m[4].close);
        expect(rolled[0].high).toBe(Math.max(...bars1m.slice(0, 5).map((b) => b.high)));
        expect(rolled[0].low).toBe(Math.min(...bars1m.slice(0, 5).map((b) => b.low)));
        expect(rolled[0].volume).toBe(50);
    });

    it("groups 1m into 15m buckets", () => {
        const rolled = rollUp(bars1m, "15m");
        expect(rolled).toHaveLength(1);
        expect(rolled[0].volume).toBe(150);
        expect(rolled[0].close).toBe(bars1m[14].close);
    });

    it("conserves volume across granularities", () => {
        const total = bars1m.reduce((a, b) => a + b.volume, 0);
        expect(rollUp(bars1m, "5m").reduce((a, b) => a + b.volume, 0)).toBe(total);
        expect(rollUp(bars1m, "15m").reduce((a, b) => a + b.volume, 0)).toBe(total);
    });

    it("does not merge bars across sessions", () => {
        const twoDays = [
            { ts: bucketTimestamp(at(10, 0), "1m"), open: 1, high: 1, low: 1, close: 1, volume: 5 },
            { ts: bucketTimestamp(Date.UTC(2026, 8, 2, 0, 10 * 60 - 330), "1m"),
              open: 2, high: 2, low: 2, close: 2, volume: 5 },
        ];
        expect(rollUp(twoDays, "15m")).toHaveLength(2);
    });

    it("is deterministic", () => {
        const first = JSON.stringify(rollUp(bars1m, "5m"));
        for (let i = 0; i < 20; i += 1) expect(JSON.stringify(rollUp(bars1m, "5m"))).toBe(first);
    });
});

// Minimal in-memory Redis double covering only what the aggregator uses.
class FakeRedis {
    constructor() { this.lists = new Map(); }
    async rpush(k, v) { const l = this.lists.get(k) ?? []; l.push(v); this.lists.set(k, l); return l.length; }
    async lrange(k, start, stop) {
        const l = this.lists.get(k) ?? [];
        const s = start < 0 ? Math.max(0, l.length + start) : start;
        const e = stop < 0 ? l.length + stop : stop;
        return l.slice(s, e + 1);
    }
    async lindex(k, i) { const l = this.lists.get(k) ?? []; return i < 0 ? l[l.length + i] ?? null : l[i] ?? null; }
    async ltrim(k, start, stop) {
        const l = this.lists.get(k) ?? [];
        const s = start < 0 ? Math.max(0, l.length + start) : start;
        const e = stop < 0 ? l.length + stop : stop;
        this.lists.set(k, l.slice(s, e + 1));
    }
    async del(k) { this.lists.delete(k); }
    pipeline() {
        const ops = [];
        const self = this;
        return {
            del(k) { ops.push(() => self.del(k)); return this; },
            rpush(k, v) { ops.push(() => self.rpush(k, v)); return this; },
            async exec() { for (const op of ops) await op(); },
        };
    }
}

describe("BarAggregator against a Redis double", () => {
    let redis, agg;
    beforeEach(() => { redis = new FakeRedis(); agg = new BarAggregator({ redis }); });

    const tick = (symbol, price, volume, h, m, s = 0) =>
        ({ symbol, price, volume, timestamp: at(h, m, s) });

    it("closes a 1m bar when the minute rolls over", async () => {
        expect(await agg.ingest(tick("A", 100, 1000, 10, 0, 5))).toBeNull();
        expect(await agg.ingest(tick("A", 102, 1200, 10, 0, 40))).toBeNull();
        const closed = await agg.ingest(tick("A", 103, 1300, 10, 1, 5));
        expect(closed).toMatchObject({ open: 100, high: 102, low: 100, close: 102, volume: 200 });
        expect(await redis.lrange("bars:1m:A", 0, -1)).toHaveLength(1);
    });

    it("derives 5m and 15m whenever a 1m bar is stored", async () => {
        for (let m = 0; m < 7; m += 1) {
            await agg.ingest(tick("A", 100 + m, 1000 + m * 100, 10, m));
        }
        expect((await redis.lrange("bars:5m:A", 0, -1)).length).toBeGreaterThan(0);
        expect((await redis.lrange("bars:15m:A", 0, -1)).length).toBeGreaterThan(0);
    });

    it("ignores ticks outside the session", async () => {
        expect(await agg.ingest(tick("A", 100, 1000, 8, 0))).toBeNull();
        expect(await agg.ingest(tick("A", 100, 1000, 16, 0))).toBeNull();
        expect(agg.health().ignoredOutOfSession).toBe(2);
        expect(await redis.lrange("bars:1m:A", 0, -1)).toHaveLength(0);
    });

    it("never stores a 15:30 bar", async () => {
        await agg.ingest(tick("A", 100, 1000, 15, 29));
        await agg.ingest(tick("A", 101, 1100, 15, 30));   // must be ignored
        await agg.flush();
        const bars = (await redis.lrange("bars:1m:A", 0, -1)).map(JSON.parse);
        expect(bars.every((b) => new Date(b.ts).getTime() <= at(15, 29))).toBe(true);
    });

    it("suppresses a duplicate bar for the same minute", async () => {
        await agg.ingest(tick("A", 100, 1000, 10, 0));
        await agg.ingest(tick("A", 101, 1100, 10, 1));
        await agg.flush();
        const before = (await redis.lrange("bars:1m:A", 0, -1)).length;
        await agg.persist("A", JSON.parse((await redis.lindex("bars:1m:A", -1))));
        expect((await redis.lrange("bars:1m:A", 0, -1)).length).toBe(before);
    });

    it("counts out-of-order ticks without corrupting the bar", async () => {
        await agg.ingest(tick("A", 100, 1000, 10, 0, 30));
        await agg.ingest(tick("A", 999, 1100, 10, 0, 10));   // older
        const closed = await agg.ingest(tick("A", 101, 1200, 10, 1));
        expect(closed.close).toBe(100);
        expect(agg.health().ignoredOutOfOrder).toBe(1);
    });

    it("handles a missing tick period without inventing bars", async () => {
        await agg.ingest(tick("A", 100, 1000, 10, 0));
        await agg.ingest(tick("A", 110, 2000, 10, 30));   // 30-minute gap
        await agg.flush();
        const bars = (await redis.lrange("bars:1m:A", 0, -1)).map(JSON.parse);
        expect(bars).toHaveLength(2);   // two real bars, no synthetic filler
    });

    it("keeps symbols independent", async () => {
        await agg.ingest(tick("A", 100, 1000, 10, 0));
        await agg.ingest(tick("B", 200, 5000, 10, 0));
        await agg.ingest(tick("A", 101, 1100, 10, 1));
        await agg.ingest(tick("B", 201, 5100, 10, 1));
        expect((await redis.lrange("bars:1m:A", 0, -1))).toHaveLength(1);
        expect((await redis.lrange("bars:1m:B", 0, -1))).toHaveLength(1);
    });

    it("survives a restart: stored bars persist, in-progress bar is simply lost", async () => {
        await agg.ingest(tick("A", 100, 1000, 10, 0));
        await agg.ingest(tick("A", 101, 1100, 10, 1));   // closes minute 10:00
        const restarted = new BarAggregator({ redis });   // fresh process
        expect((await redis.lrange("bars:1m:A", 0, -1))).toHaveLength(1);
        expect(restarted.health().symbolsInProgress).toBe(0);
    });

    it("a Redis failure does not break the price path", async () => {
        const broken = new BarAggregator({
            redis: { ...redis, rpush: async () => { throw new Error("redis down"); },
                     lindex: async () => null } });
        await broken.ingest(tick("A", 100, 1000, 10, 0));
        await expect(broken.ingest(tick("A", 101, 1100, 10, 1))).resolves.not.toThrow();
    });

    it("caps stored history", async () => {
        const small = new BarAggregator({ redis, maxBars: 3 });
        for (let m = 0; m < 8; m += 1) await small.ingest(tick("A", 100 + m, 1000 + m * 10, 10, m));
        expect((await redis.lrange("bars:1m:A", 0, -1)).length).toBeLessThanOrEqual(3);
    });
});

// F10. Bars used to publish only when the next minute's first tick arrived, so
// on a thin symbol the intelligence layer ran on a cadence set by tick density.
describe("bars close on a clock, not on the next tick", () => {
    const at = (h, m, s = 0) => Date.UTC(2026, 7, 31, 0, h * 60 + m - 330, s);

    const fakeRedis = () => {
        const lists = new Map();
        return {
            lists,
            lindex: async (k, i) => {
                const l = lists.get(k) ?? [];
                return i === -1 ? (l[l.length - 1] ?? null) : (l[i] ?? null);
            },
            rpush: async (k, v) => { lists.set(k, [...(lists.get(k) ?? []), v]); },
            ltrim: async () => {},
            lrange: async (k) => lists.get(k) ?? [],
            pipeline: () => {
                const ops = [];
                const api = {
                    del: (k) => { ops.push(() => lists.delete(k)); return api; },
                    rpush: (k, v) => { ops.push(() => lists.set(k, [...(lists.get(k) ?? []), v])); return api; },
                    exec: async () => { ops.forEach((f) => f()); },
                };
                return api;
            },
        };
    };

    it("publishes a completed minute without waiting for another tick", async () => {
        const redis = fakeRedis();
        const agg = new BarAggregator({ redis });
        await agg.ingest({ symbol: "THIN", price: 100, volume: 1000, timestamp: at(10, 0, 5) });
        await agg.ingest({ symbol: "THIN", price: 101, volume: 1100, timestamp: at(10, 0, 40) });
        expect(redis.lists.get("bars:1m:THIN")).toBeUndefined();   // still accumulating

        // The minute ends. No further tick arrives on this thin name.
        const closed = await agg.closeCompleted(at(10, 1, 2));
        expect(closed).toEqual(["THIN"]);
        const bars = redis.lists.get("bars:1m:THIN").map(JSON.parse);
        expect(bars).toHaveLength(1);
        expect(bars[0].open).toBe(100);
        expect(bars[0].close).toBe(101);
    });

    it("leaves the minute still in progress alone", async () => {
        const redis = fakeRedis();
        const agg = new BarAggregator({ redis });
        await agg.ingest({ symbol: "LIVE", price: 100, volume: 1000, timestamp: at(10, 0, 5) });
        expect(await agg.closeCompleted(at(10, 0, 55))).toEqual([]);
        expect(redis.lists.get("bars:1m:LIVE")).toBeUndefined();
    });

    it("closing twice does not duplicate the bar", async () => {
        const redis = fakeRedis();
        const agg = new BarAggregator({ redis });
        await agg.ingest({ symbol: "THIN", price: 100, volume: 1000, timestamp: at(10, 0, 5) });
        await agg.closeCompleted(at(10, 1, 2));
        await agg.closeCompleted(at(10, 1, 5));
        expect(redis.lists.get("bars:1m:THIN")).toHaveLength(1);
    });

    it("derived granularities follow from the clock-closed 1m series", async () => {
        const redis = fakeRedis();
        const agg = new BarAggregator({ redis });
        for (let m = 0; m < 5; m += 1) {
            await agg.ingest({ symbol: "THIN", price: 100 + m, volume: 1000 + m * 10,
                               timestamp: at(10, m, 5) });
            await agg.closeCompleted(at(10, m + 1, 2));
        }
        expect(redis.lists.get("bars:1m:THIN")).toHaveLength(5);
        expect((redis.lists.get("bars:5m:THIN") ?? []).length).toBeGreaterThan(0);
    });
});

// G1. Derived bars were rebuilt by full rewrite on every close. Across the
// universe at the minute boundary that was 87.5 ms of synchronous work, and a
// tick crossing a stop queued behind it. The bucket containing the closed bar
// is the only one that can have changed.
describe("derived bars update incrementally", () => {
    const at = (h, m, s = 0) => Date.UTC(2026, 7, 31, 0, h * 60 + m - 330, s);

    const countingRedis = () => {
        const lists = new Map();
        const ops = { lrange: 0, rpush: 0, del: 0, lset: 0, lindex: 0, ltrim: 0, scanned: 0 };
        return {
            lists, ops,
            lindex: async (k, i) => {
                ops.lindex += 1;
                const l = lists.get(k) ?? [];
                return i === -1 ? (l[l.length - 1] ?? null) : (l[i] ?? null);
            },
            rpush: async (k, v) => { ops.rpush += 1; lists.set(k, [...(lists.get(k) ?? []), v]); },
            lset: async (k, i, v) => {
                ops.lset += 1;
                const l = lists.get(k) ?? [];
                l[i === -1 ? l.length - 1 : i] = v;
                lists.set(k, l);
            },
            ltrim: async (k, start) => {
                ops.ltrim += 1;
                const l = lists.get(k) ?? [];
                if (start < 0) lists.set(k, l.slice(start));
            },
            lrange: async (k, start, end) => {
                ops.lrange += 1;
                const l = lists.get(k) ?? [];
                const slice = end === -1 ? l.slice(start) : l.slice(start, end + 1);
                ops.scanned += slice.length;
                return slice;
            },
            pipeline: () => {
                const queued = [];
                const api = {
                    del: (k) => { queued.push(() => { ops.del += 1; lists.delete(k); }); return api; },
                    rpush: (k, v) => {
                        queued.push(() => { ops.rpush += 1; lists.set(k, [...(lists.get(k) ?? []), v]); });
                        return api;
                    },
                    exec: async () => { queued.forEach((f) => f()); },
                };
                return api;
            },
        };
    };

    const feed = async (agg, minutes) => {
        for (let m = 0; m < minutes; m += 1) {
            await agg.ingest({ symbol: "ACC", price: 1000 + m, volume: 10_000 + m * 50,
                               timestamp: at(10, m, 5) });
            await agg.closeCompleted(at(10, m + 1, 2));
        }
    };

    it("produces the same series the full rebuild produced", async () => {
        const incremental = countingRedis();
        const full = countingRedis();
        const a = new BarAggregator({ redis: incremental });
        const b = new BarAggregator({ redis: full });

        await feed(a, 34);
        await feed(b, 34);
        // Force the whole-series path on the second aggregator for comparison.
        await b.rebuildDerivedFull("ACC");

        for (const g of ["5m", "15m"]) {
            expect(incremental.lists.get(`bars:${g}:ACC`))
                .toEqual(full.lists.get(`bars:${g}:ACC`));
        }
    });

    it("reads only the bucket, not the whole retained series", async () => {
        const redis = countingRedis();
        const agg = new BarAggregator({ redis });
        await feed(agg, 40);
        const before = redis.ops.scanned;

        await agg.ingest({ symbol: "ACC", price: 1100, volume: 20_000, timestamp: at(10, 40, 5) });
        await agg.closeCompleted(at(10, 41, 2));
        const scannedForOneClose = redis.ops.scanned - before;

        // A 15m bucket is at most 15 one-minute bars; the old path read 240.
        expect(scannedForOneClose).toBeLessThanOrEqual(15 + 5 + 1);
    });

    it("never deletes and rewrites a derived list on the hot path", async () => {
        const redis = countingRedis();
        const agg = new BarAggregator({ redis });
        await feed(agg, 40);
        expect(redis.ops.del).toBe(0);
    });

    it("replaces the open bucket in place rather than appending a duplicate", async () => {
        const redis = countingRedis();
        const agg = new BarAggregator({ redis });
        await feed(agg, 3);   // all inside one 5m and one 15m bucket
        expect(redis.lists.get("bars:5m:ACC")).toHaveLength(1);
        expect(redis.lists.get("bars:15m:ACC")).toHaveLength(1);
        const bar = JSON.parse(redis.lists.get("bars:5m:ACC")[0]);
        expect(bar.open).toBe(1000);
        expect(bar.close).toBe(1002);
    });

    it("opens a new bucket when the boundary is crossed", async () => {
        const redis = countingRedis();
        const agg = new BarAggregator({ redis });
        await feed(agg, 7);   // spans two 5m buckets
        expect(redis.lists.get("bars:5m:ACC")).toHaveLength(2);
        expect(redis.lists.get("bars:15m:ACC")).toHaveLength(1);
    });

    it("aggregates high, low and volume correctly inside a bucket", async () => {
        const redis = countingRedis();
        const agg = new BarAggregator({ redis });
        for (const [m, price] of [[0, 1000], [1, 1050], [2, 990], [3, 1010], [4, 1005]]) {
            await agg.ingest({ symbol: "ACC", price, volume: 10_000 + m * 100,
                               timestamp: at(10, m, 5) });
            await agg.ingest({ symbol: "ACC", price: price + 2, volume: 10_000 + m * 100 + 50,
                               timestamp: at(10, m, 30) });
            await agg.closeCompleted(at(10, m + 1, 2));
        }
        const bar = JSON.parse(redis.lists.get("bars:5m:ACC")[0]);
        expect(bar.open).toBe(1000);
        expect(bar.high).toBe(1052);
        expect(bar.low).toBe(990);
        expect(bar.close).toBe(1007);
    });

    it("the full rebuild remains available for recovery", async () => {
        const redis = countingRedis();
        const agg = new BarAggregator({ redis });
        await feed(agg, 12);
        const expected = redis.lists.get("bars:5m:ACC").slice();
        redis.lists.delete("bars:5m:ACC");
        redis.lists.delete("bars:15m:ACC");
        await agg.rebuildDerivedFull("ACC");
        expect(redis.lists.get("bars:5m:ACC")).toEqual(expected);
    });
});
