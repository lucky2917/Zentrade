import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;

// The fast plane, wired end to end.
//
// The brain publishes commitments, the Go plane protects, and the brain reads
// back what the plane saw. This runs the REAL binary against a REAL Redis: a
// mock on either side would prove the two mocks agree.
//
// It does not use a live venue and does not claim to. What it proves is the
// boundary: contract, ownership, restart replay and divergence accounting.

const GO_DIR = join(process.cwd(), "../../go");
const TICK_CHANNEL = "price:update";

const buildDaemon = () => {
    const out = join(mkdtempSync(join(tmpdir(), "zt-plane-")), "marketdatad");
    execFileSync("go", ["build", "-o", out, "./cmd/marketdatad"], { cwd: GO_DIR });
    return out;
};

const waitFor = async (predicate, { timeoutMs = 8_000, label = "condition" } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${label}`);
};

describe.skipIf(!TEST_REDIS || !process.env.ZENTRADE_GO_E2E)("fast plane end to end", () => {
    let redis, FastPlaneBridge, PLANE_MODE, binary;
    let daemon = null;
    const SYMBOL = "RELIANCE";

    const startDaemon = (extraEnv = {}) => {
        const child = spawn(binary,
            ["-mode", "shadow", "-sweep", "200ms", "-health", "127.0.0.1:5699"],
            { env: { ...process.env, REDIS_URL: TEST_REDIS, ...extraEnv },
              stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", () => {});
        child.stderr.on("data", () => {});
        return child;
    };

    const stopDaemon = async (child) => {
        if (!child || child.exitCode !== null) return;
        child.kill("SIGTERM");
        await new Promise((r) => { child.on("exit", r); setTimeout(r, 3_000); });
    };

    beforeEach(async () => {
        ({ default: redis } = await import("../config/redis.js"));
        ({ FastPlaneBridge, PLANE_MODE } = await import("../services/tick/fastPlane.js"));
        if (!binary) binary = buildDaemon();
        await redis.del("zentrade:marketdata:owner", "marketdata:commands:state",
                        "shadow:marketdata:events", "marketdata:events");
    });

    afterAll(async () => { await stopDaemon(daemon); });

    it("protects a commitment the brain published, in the other process", async () => {
        daemon = startDaemon();
        const bridge = new FastPlaneBridge({ mode: PLANE_MODE.SHADOW, client: redis });

        await waitFor(() => redis.get("zentrade:marketdata:owner"),
                      { label: "the plane to take the lease" });

        bridge.arm(SYMBOL, {
            thesisId: "t-1", direction: "LONG", stopPaise: 98_000,
            targetPaise: 108_000, quantity: 10, correlationId: "c-1",
        });
        await waitFor(() => redis.hget("marketdata:commands:state", SYMBOL),
                      { label: "the command to be recorded" });
        // The daemon subscribes asynchronously; give the ARM time to land
        // before the tick that depends on it.
        await new Promise((r) => setTimeout(r, 300));

        await redis.publish(TICK_CHANNEL, JSON.stringify({
            symbol: SYMBOL, price: 970, volume: 500_000, timestamp: Date.now(),
            source: "websocket",
        }));

        const events = await waitFor(async () => {
            const got = await bridge.drainEvents();
            return got.length ? got : null;
        }, { label: "a protective event from the plane" });

        expect(events[0].kind).toBe("STOP");
        expect(events[0].symbol).toBe(SYMBOL);
        expect(events[0].severity).toBe("CRITICAL");
        expect(events[0].pricePaise).toBe(97_000);
        expect(events[0].thesisId).toBe("t-1");
        await stopDaemon(daemon);
    }, 40_000);

    // A plane that came up after the brain had armed its positions would
    // protect nothing until the next entry.
    it("replays the brain's commitments after a restart", async () => {
        const bridge = new FastPlaneBridge({ mode: PLANE_MODE.SHADOW, client: redis });
        bridge.arm(SYMBOL, {
            thesisId: "t-2", direction: "LONG", stopPaise: 98_000,
            targetPaise: 108_000, quantity: 10, correlationId: "c-2",
        });
        await waitFor(() => redis.hget("marketdata:commands:state", SYMBOL),
                      { label: "the command state to be written" });

        // The plane starts AFTER the commitment already existed.
        daemon = startDaemon();
        await waitFor(() => redis.get("zentrade:marketdata:owner"),
                      { label: "the plane to take the lease" });
        await new Promise((r) => setTimeout(r, 400));

        await redis.publish(TICK_CHANNEL, JSON.stringify({
            symbol: SYMBOL, price: 975, timestamp: Date.now(), source: "websocket",
        }));

        const events = await waitFor(async () => {
            const got = await bridge.drainEvents();
            return got.length ? got : null;
        }, { label: "protection from a replayed commitment" });
        expect(events[0].kind).toBe("STOP");
        await stopDaemon(daemon);
    }, 40_000);

    it("refuses to start a second owner", async () => {
        daemon = startDaemon();
        await waitFor(() => redis.get("zentrade:marketdata:owner"),
                      { label: "the first plane to take the lease" });

        const second = startDaemon();
        const code = await new Promise((resolve) => {
            second.on("exit", resolve);
            setTimeout(() => resolve(null), 8_000);
        });
        expect(code).not.toBe(0);
        expect(code).not.toBeNull();
        await stopDaemon(daemon);
    }, 40_000);
});

// The comparison arithmetic needs no Redis and no daemon, so it is always run.
describe("shadow divergence accounting", () => {
    let FastPlaneBridge, PLANE_MODE, CROSSING;

    beforeEach(async () => {
        ({ FastPlaneBridge, PLANE_MODE } = await import("../services/tick/fastPlane.js"));
        ({ CROSSING } = await import("../services/tick/reflex.js"));
    });

    const crossing = (kind, pricePaise, levelPaise) => ({
        kind, symbol: "RELIANCE", pricePaise, levelPaise });
    const planeEvent = (kind, pricePaise, levelPaise) => ({
        contract: "zentrade.marketdata.event.v1", kind,
        symbol: "RELIANCE", pricePaise, levelPaise });

    it("counts an identical crossing as agreement", () => {
        const bridge = new FastPlaneBridge({ mode: PLANE_MODE.SHADOW });
        const result = bridge.reconcile(
            [crossing(CROSSING.STOP, 97_000, 98_000)],
            [planeEvent("STOP", 97_000, 98_000)]);
        expect(result).toEqual({ agreed: 1, onlyPlane: [], onlyBrain: [] });
        expect(bridge.health().divergence).toBe(0);
    });

    it("reports a crossing only one side saw", () => {
        const bridge = new FastPlaneBridge({ mode: PLANE_MODE.SHADOW });
        const result = bridge.reconcile(
            [crossing(CROSSING.STOP, 97_000, 98_000)],
            [planeEvent("STOP", 97_000, 98_000), planeEvent("TARGET", 109_000, 108_000)]);
        expect(result.agreed).toBe(1);
        expect(result.onlyPlane).toEqual(["TARGET:RELIANCE:109000:108000"]);
        expect(bridge.health().divergence).toBe(1);
    });

    it("translates the reflex vocabulary into the contract's", () => {
        const bridge = new FastPlaneBridge({ mode: PLANE_MODE.SHADOW });
        const result = bridge.reconcile(
            [crossing(CROSSING.VWAP_DEVIATION, 102_500, 100_000)],
            [planeEvent("VWAP_DEVIATION", 102_500, 100_000)]);
        expect(result.agreed).toBe(1);
    });

    it("rejects an event from an unknown contract", async () => {
        const client = {
            eval: async () => [JSON.stringify({ contract: "v2", kind: "STOP" })],
        };
        const bridge = new FastPlaneBridge({ mode: PLANE_MODE.SHADOW, client });
        expect(await bridge.drainEvents()).toEqual([]);
    });

    it("publishes nothing at all when the plane is off", () => {
        const bridge = new FastPlaneBridge({ mode: PLANE_MODE.OFF });
        expect(bridge.arm("X", { stopPaise: 1 })).toBe(false);
        expect(bridge.health().commandsPublished).toBe(0);
        expect(bridge.commitments.size).toBe(0);
    });

    it("keeps the per-symbol state a restarted plane replays", () => {
        const bridge = new FastPlaneBridge({
            mode: PLANE_MODE.SHADOW,
            client: { publish: async () => 1, hset: async () => 1 },
        });
        bridge.arm("A", { stopPaise: 1 });
        bridge.watch("A", { entryPaise: 2 });
        expect(bridge.commitments.get("A").map((c) => c.op)).toEqual(["ARM", "WATCH"]);
        bridge.disarm("A");
        expect(bridge.commitments.get("A").map((c) => c.op)).toEqual(["WATCH"]);
        bridge.unwatch("A");
        expect(bridge.commitments.has("A")).toBe(false);
    });

    // Two commands issued microseconds apart used to race to Redis. An ARM
    // landing after its own DISARM leaves the plane protecting a position the
    // brain has already closed, and it would then fire a protective exit
    // against a holding that no longer exists.
    it("puts commands on the wire in the order they were issued", async () => {
        const landed = [];
        let firstCallDelay = 40;
        const bridge = new FastPlaneBridge({
            mode: PLANE_MODE.SHADOW,
            client: {
                publish: async (_ch, payload) => {
                    const d = firstCallDelay; firstCallDelay = 0;
                    await new Promise((r) => setTimeout(r, d));
                    landed.push(JSON.parse(payload).op);
                },
                hset: async () => 1,
            },
        });

        bridge.arm("RELIANCE", { stopPaise: 98_000 });
        bridge.disarm("RELIANCE");
        await bridge.flush();

        expect(landed).toEqual(["ARM", "DISARM"]);
    });

    it("publishes the per-symbol state as it was at issue time", async () => {
        const states = [];
        const bridge = new FastPlaneBridge({
            mode: PLANE_MODE.SHADOW,
            client: {
                publish: async () => { await new Promise((r) => setTimeout(r, 5)); },
                hset: async (_k, _f, value) => { states.push(JSON.parse(value).map((c) => c.op)); },
            },
        });

        bridge.arm("A", { stopPaise: 1 });
        bridge.watch("A", { entryPaise: 2 });
        bridge.disarm("A");
        await bridge.flush();

        // Each write carries the state as it stood when that command was
        // issued, not whatever the map held when the write happened to run.
        expect(states).toEqual([["ARM"], ["ARM", "WATCH"], ["WATCH"]]);
    });

    // LRANGE then LTRIM is two round trips with a window in between, and the
    // plane bounds the same list from the other end.
    it("reads and removes events in one atomic step", async () => {
        const calls = [];
        const bridge = new FastPlaneBridge({
            mode: PLANE_MODE.SHADOW,
            client: {
                eval: async (script, keys, key, limit) => {
                    calls.push({ keys, key, limit });
                    return [JSON.stringify({ contract: "zentrade.marketdata.event.v1",
                                             kind: "STOP", symbol: "X",
                                             pricePaise: 1, levelPaise: 2 })];
                },
                lrange: async () => { throw new Error("must not read separately"); },
                ltrim: async () => { throw new Error("must not trim separately"); },
            },
        });

        const events = await bridge.drainEvents(50);
        expect(events).toHaveLength(1);
        expect(calls).toEqual([{ keys: 1, key: "shadow:marketdata:events", limit: "50" }]);
    });

    it("survives a publish failure without throwing into the tick path", async () => {
        const bridge = new FastPlaneBridge({
            mode: PLANE_MODE.SHADOW,
            client: { publish: async () => { throw new Error("redis down"); },
                      hset: async () => 1 },
        });
        expect(() => bridge.arm("A", { stopPaise: 1 })).not.toThrow();
        await bridge.flush();
        expect(bridge.health().publishFailures).toBe(1);

        // And a failed command must not poison the chain for the next one.
        bridge.client.publish = async () => 1;
        bridge.arm("B", { stopPaise: 1 });
        await bridge.flush();
        expect(bridge.health().commandsPublished).toBe(1);
    });
});
