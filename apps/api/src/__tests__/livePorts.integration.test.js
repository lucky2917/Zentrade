import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// The live ports against real Postgres and real Redis. Only Fyers and the LLM
// are absent; everything else is the production path.

describe.skipIf(!TEST_DB || !TEST_REDIS)("live ports (integration)", () => {
    let pool, redis, engine, buildLivePorts, NewsStore, ConnectionTracker, AutonomousRuntime, MODE;
    const USER = 3131;
    const CASH = 200_000_000;

    beforeEach(async () => {
        ({ pool } = await import("../config/db.js"));
        ({ default: redis } = await import("../config/redis.js"));
        engine = await import("../services/execution/engine.js");
        ({ buildLivePorts } = await import("../services/autonomous/livePorts.js"));
        ({ NewsStore } = await import("../services/news/ingest.js"));
        ({ ConnectionTracker } = await import("../services/orchestrator/connectionState.js"));
        ({ AutonomousRuntime, MODE } = await import("../services/autonomous/runtime.js"));

        await pool.query("DELETE FROM position_events WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM position_reassessments WHERE thesis_id IN (SELECT id FROM trade_thesis WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM trade_thesis WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'live@test',$2)
             ON CONFLICT (id) DO UPDATE SET balance_paise=$2`, [USER, CASH]);
        await redis.del("stock:RELIANCE", "bars:1m:RELIANCE", "bars:5m:RELIANCE", "bars:15m:RELIANCE");
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const connected = () => {
        const c = new ConnectionTracker();
        c.onConnecting(); c.onConnected(); c.onTick(Date.now());
        return c;
    };

    const makePorts = (over = {}) => buildLivePorts({
        userId: USER, newsStore: new NewsStore(), connectionTracker: connected(),
        universe: ["RELIANCE"], ...over,
    });

    const seedBars = async (symbol, closes) => {
        for (const g of ["1m", "5m", "15m"]) {
            for (const close of closes) {
                await redis.rpush(`bars:${g}:${symbol}`, JSON.stringify({
                    ts: new Date().toISOString(), close, high: close + 1, low: close - 1, volume: 5000 }));
            }
        }
    };

    describe("observations from real Redis", () => {
        it("reads ticks and bar history", async () => {
            await redis.set("stock:RELIANCE", JSON.stringify({
                symbol: "RELIANCE", price: 1010, volume: 100, timestamp: new Date().toISOString() }));
            await seedBars("RELIANCE", [1000, 1001, 1002, 1003, 1004]);

            const observations = await makePorts().loadObservations();
            const reliance = observations.find((o) => o.symbol === "RELIANCE");
            expect(reliance.price).toBe(1010);
            expect(reliance.bars1m.length).toBe(5);
            expect(reliance.stale).toBe(false);
        });

        it("marks a symbol with no tick as stale rather than omitting it", async () => {
            const observations = await makePorts().loadObservations();
            const reliance = observations.find((o) => o.symbol === "RELIANCE");
            expect(reliance).toBeDefined();
            expect(reliance.stale).toBe(true);
            expect(reliance.price).toBeNull();
        });

        it("marks everything stale when the connection is untrusted", async () => {
            await redis.set("stock:RELIANCE", JSON.stringify({
                symbol: "RELIANCE", price: 1010, timestamp: new Date().toISOString() }));
            const dead = new ConnectionTracker();   // DISCONNECTED
            const observations = await buildLivePorts({
                userId: USER, newsStore: new NewsStore(), connectionTracker: dead,
                universe: ["RELIANCE"] }).loadObservations();
            expect(observations[0].stale).toBe(true);
        });

        it("skips malformed cached bars without throwing", async () => {
            await redis.rpush("bars:1m:RELIANCE", "not json");
            await redis.rpush("bars:1m:RELIANCE", JSON.stringify({ close: 100 }));
            const observations = await makePorts().loadObservations();
            expect(observations[0].bars1m).toHaveLength(1);
        });
    });

    describe("event persistence and dedup", () => {
        it("refreshes a condition that is still pending, and deduplicates once handled", async () => {
            const ports = makePorts();
            const event = {
                key: "k-1", type: "PRICE_JUMP", severity: "WARNING", symbol: "RELIANCE",
                correlationId: "c-1", source: "test", observed: { x: 1 }, reason: "r",
                observedAt: new Date().toISOString() };
            const first = await ports.recordEvent(event);
            expect(first).not.toBeNull();
            // Still outstanding: re-observing must NOT discard it, or a
            // condition dropped by the queue could never come back (red team F5).
            const second = await ports.recordEvent(event);
            expect(second).not.toBeNull();
            expect(second.id).toBe(first.id);
            // Once reasoned about, it is genuinely deduplicated.
            await ports.markEventHandled(first.id);
            expect(await ports.recordEvent(event)).toBeNull();
        });
    });

    describe("session counters from real orders", () => {
        it("counts today's trades and turnover", async () => {
            const { order } = await engine.submitOrder({
                userId: USER, symbol: "RELIANCE", side: "BUY", quantity: 100,
                pricePaise: 100000, clientOrderId: "sc-1", correlationId: "c" });
            await engine.acceptOrder(order.id);

            const counters = await makePorts().sessionCounters();
            expect(counters.trades).toBeGreaterThanOrEqual(1);
            expect(counters.turnoverPaise).toBeGreaterThan(0);
        });

        it("lists open client order ids for duplicate protection", async () => {
            const { order } = await engine.submitOrder({
                userId: USER, symbol: "RELIANCE", side: "BUY", quantity: 100,
                pricePaise: 100000, clientOrderId: "open-1", correlationId: "c" });
            await engine.acceptOrder(order.id);
            expect(await makePorts().openClientOrderIds()).toContain("open-1");
        });
    });

    describe("thesis recording gates entry", () => {
        it("records a valid thesis", async () => {
            const thesis = await makePorts().recordThesis({
                symbol: "RELIANCE", correlationId: "t-corr",
                decision: { reasoning: "breakout", setupType: "breakout" },
                context: { sessionPhase: "MID_SESSION" },
                intent: { side: "BUY", pricePaise: 100000, quantity: 100 },
            });
            expect(thesis.symbol).toBe("RELIANCE");
            expect(thesis.invalidation_conditions.length).toBeGreaterThan(0);
        });

        it("aborts the entry when the thesis is rejected", async () => {
            await expect(makePorts().recordThesis({
                symbol: "RELIANCE", correlationId: "bad",
                decision: { reasoning: "x", setupType: "x", invalidationConditions: [] },
                context: {},
                intent: { side: "BUY", pricePaise: 100000, quantity: 100 },
            })).rejects.toThrow();
        });
    });

    describe("risk uses real portfolio and session state", () => {
        it("rejects when real cash is insufficient", async () => {
            await pool.query("UPDATE users SET balance_paise = 1000 WHERE id=$1", [USER]);
            const risk = await makePorts().evaluateRisk({
                action: "BUY", side: "BUY", symbol: "RELIANCE", quantity: 100, pricePaise: 100000 });
            expect(risk.decision).toBe("REJECT");
        });

        it("blocks new exposure when the connection is untrusted", async () => {
            const dead = new ConnectionTracker();
            const risk = await buildLivePorts({
                userId: USER, newsStore: new NewsStore(), connectionTracker: dead,
            }).evaluateRisk({
                action: "BUY", side: "BUY", symbol: "RELIANCE", quantity: 100, pricePaise: 100000 });
            expect(risk.decision).toBe("REJECT");
            expect(risk.code).toBe("STALE_DATA");
        });
    });

    describe("the runtime starts on live ports", () => {
        it("starts, reports paper mode, and stops cleanly", async () => {
            const runtime = new AutonomousRuntime({
                engine, reconciler: await import("../services/execution/reconcile.js"),
                userId: USER, ports: makePorts(),
            });
            expect(await runtime.start()).toBe(true);
            const health = runtime.health();
            expect(health.mode).toBe(MODE.PAPER);
            expect(health.liveExecutionEnabled).toBe(false);
            expect(health.orchestrator.scheduler.jobCount).toBe(8);
            expect(await runtime.stop()).toBe(true);
        });

        it("runs a monitor cycle against real infrastructure", async () => {
            await redis.set("stock:RELIANCE", JSON.stringify({
                symbol: "RELIANCE", price: 1010, timestamp: new Date().toISOString() }));
            await seedBars("RELIANCE", Array.from({ length: 45 }, (_, i) => 1000 + (i % 2 ? -0.5 : 0.5)));

            const runtime = new AutonomousRuntime({
                engine, reconciler: await import("../services/execution/reconcile.js"),
                userId: USER, ports: makePorts(),
            });
            await runtime.start();
            const result = await runtime.orchestrator.monitorCycle();
            expect(result).toHaveProperty("events");
            expect(runtime.health().orchestrator.metrics.cycles).toBe(1);
            await runtime.stop();
        });
    });

    describe("production safety", () => {
        it("cannot be constructed in live mode", () => {
            expect(() => new AutonomousRuntime({
                engine, ports: makePorts(), mode: "LIVE" })).toThrow(/paper only/);
        });

        it("rejects any mode that is not PAPER, including empty and undefined-ish values", () => {
            for (const mode of ["live", "LIVE", "production", "", null, 1]) {
                expect(() => new AutonomousRuntime({ engine, ports: makePorts(), mode }))
                    .toThrow(/paper only/);
            }
        });
    });
});
