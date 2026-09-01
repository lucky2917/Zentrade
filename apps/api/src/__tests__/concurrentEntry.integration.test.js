import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SymbolGate, entryIntentKey, positionIntentKey } from "../services/autonomous/symbolGate.js";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

describe("single flight per symbol", () => {
    it("a second holder is refused while the first is working", () => {
        const gate = new SymbolGate();
        const release = gate.acquire("RELIANCE", "scan");
        expect(release).toBeTruthy();
        expect(gate.acquire("RELIANCE", "reasoning")).toBeNull();
        release();
        expect(gate.acquire("RELIANCE", "reasoning")).toBeTruthy();
    });

    it("different symbols do not block each other", () => {
        const gate = new SymbolGate();
        expect(gate.acquire("RELIANCE")).toBeTruthy();
        expect(gate.acquire("TCS")).toBeTruthy();
    });

    it("a lock left by a dead holder is reclaimed rather than deadlocking the symbol", () => {
        let now = 1_000_000;
        const gate = new SymbolGate({ clock: () => now, staleAfterMs: 60_000 });
        gate.acquire("RELIANCE", "crashed");
        now += 61_000;
        expect(gate.acquire("RELIANCE", "next")).toBeTruthy();
        expect(gate.health().forced).toBe(1);
    });

    it("releasing twice is harmless", () => {
        const gate = new SymbolGate();
        const release = gate.acquire("RELIANCE");
        release(); release();
        expect(gate.isHeld("RELIANCE")).toBe(false);
    });
});

describe("intent identity", () => {
    const at = new Date("2026-08-31T05:00:00Z");

    it("two decisions in the same session and position state collide", () => {
        expect(entryIntentKey({ symbol: "RELIANCE", action: "BUY", at, epoch: 0 }))
            .toBe(entryIntentKey({ symbol: "RELIANCE", action: "BUY", at, epoch: 0 }));
    });

    it("a genuine re-entry after an exit does not collide", () => {
        expect(entryIntentKey({ symbol: "RELIANCE", action: "BUY", at, epoch: 0 }))
            .not.toBe(entryIntentKey({ symbol: "RELIANCE", action: "BUY", at, epoch: 1 }));
    });

    it("a new session starts a new identity space", () => {
        expect(entryIntentKey({ symbol: "RELIANCE", action: "BUY", at, epoch: 0 }))
            .not.toBe(entryIntentKey({ symbol: "RELIANCE", action: "BUY",
                                       at: new Date("2026-09-01T05:00:00Z"), epoch: 0 }));
    });

    it("one thesis gets one exit however many events argue for it", () => {
        expect(positionIntentKey({ thesisId: "t-1", action: "EXIT", symbol: "X", at }))
            .toBe(positionIntentKey({ thesisId: "t-1", action: "EXIT", symbol: "X", at }));
        expect(positionIntentKey({ thesisId: "t-1", action: "EXIT", symbol: "X", at }))
            .not.toBe(positionIntentKey({ thesisId: "t-1", action: "REDUCE", symbol: "X", at }));
    });
});

describe.skipIf(!TEST_DB || !TEST_REDIS)("two paths cannot open the same symbol twice", () => {
    let pool, redis, engine, reconcile, AutonomousRuntime, buildLivePorts;
    let BarAggregator, NewsStore, ConnectionTracker;
    const USER = 8494;
    const SYMBOL = "RELIANCE";
    const at = (h, m) => Date.UTC(2026, 7, 31, 0, h * 60 + m - 330, 0);

    beforeEach(async () => {
        ({ pool } = await import("../config/db.js"));
        ({ default: redis } = await import("../config/redis.js"));
        engine = await import("../services/execution/engine.js");
        reconcile = await import("../services/execution/reconcile.js");
        ({ AutonomousRuntime } = await import("../services/autonomous/runtime.js"));
        ({ buildLivePorts } = await import("../services/autonomous/livePorts.js"));
        ({ BarAggregator } = await import("../services/fyers/barAggregator.js"));
        ({ NewsStore } = await import("../services/news/ingest.js"));
        ({ ConnectionTracker } = await import("../services/orchestrator/connectionState.js"));

        await pool.query("DELETE FROM position_events WHERE user_id=$1", [USER]);
        // Cooldowns are durable now, so a symbol priced by one test would
        // otherwise be skipped by the next.
        await pool.query("DELETE FROM candidate_cooldowns WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM trade_thesis WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'conc@test',500000000)
             ON CONFLICT (id) DO UPDATE SET balance_paise=500000000`, [USER]);
        await redis.del(`stock:${SYMBOL}`, `bars:1m:${SYMBOL}`, `bars:5m:${SYMBOL}`, `bars:15m:${SYMBOL}`);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const orderCount = async () => (await pool.query(
        "SELECT COUNT(*)::int n FROM orders WHERE user_id=$1", [USER])).rows[0].n;

    it("concurrent scan and event decisions produce exactly one order", async () => {
        const agg = new BarAggregator({ redis });
        let cum = 100000;
        const prices = [...Array.from({ length: 45 }, (_, i) => 1000 + (i % 2 ? -0.5 : 0.5)), 1030];
        for (let i = 0; i < prices.length; i += 1) {
            cum += 5000;
            await agg.ingest({ symbol: SYMBOL, price: prices[i], volume: cum, timestamp: at(10, i) });
        }
        await agg.flush();
        await redis.set(`stock:${SYMBOL}`, JSON.stringify({
            symbol: SYMBOL, price: 1030, volume: cum, timestamp: new Date(at(11, 59)).toISOString() }));

        const tracker = new ConnectionTracker();
        tracker.onConnecting(); tracker.onConnected(); tracker.onTick(at(11, 59));

        // A slow analyser, so both callers are genuinely in flight together.
        const analyse = vi.fn(async () => {
            await new Promise((r) => setTimeout(r, 60));
            return { action: "BUY", confidence: "HIGH", quantity: 200,
                     reasoning: "x", setupType: "breakout", invalidationConditions: ["z"] };
        });

        // The ports must read the world at the fixture's instant, not at the
        // wall clock. Without this the pre-execution revalidation compares a
        // tick stamped 11:59 IST against real now, so the test passed in the
        // morning and failed in the afternoon for no reason it was testing.
        const ports = buildLivePorts({
            userId: USER, newsStore: new NewsStore(), connectionTracker: tracker,
            universe: [SYMBOL], analyseCandidate: analyse,
            clock: () => new Date(at(12, 0)) });
        const runtime = new AutonomousRuntime({
            engine, reconciler: reconcile, userId: USER,
            clock: () => new Date(at(12, 0)), ports });
        await runtime.start();

        const context = { asOf: new Date(at(12, 0)).toISOString(), price: 1030, stale: false };
        await Promise.all([
            runtime.handleCandidate({ symbol: SYMBOL, context, reasons: ["scan"] }),
            runtime.handleCandidate({ symbol: SYMBOL, context, reasons: ["anomaly"] }),
        ]);
        await runtime.venue.tick();

        expect(analyse).toHaveBeenCalledTimes(1);          // the gate held
        expect(await orderCount()).toBe(1);
        const { rows } = await pool.query(
            "SELECT COUNT(*)::int n FROM trade_thesis WHERE user_id=$1", [USER]);
        expect(rows[0].n).toBe(1);
        await runtime.stop();
    }, 60000);

    it("even without the gate the intent key stops a duplicate order", async () => {
        // Belt and braces: submit the same intent identity twice directly.
        const key = entryIntentKey({ symbol: SYMBOL, action: "BUY", at: new Date(at(12, 0)), epoch: 0 });
        const a = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side: "BUY", quantity: 200, pricePaise: 103_000,
            clientOrderId: key, correlationId: "one" });
        const b = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side: "BUY", quantity: 200, pricePaise: 103_000,
            clientOrderId: key, correlationId: "two" });
        expect(b.duplicate).toBe(true);
        expect(b.order.id).toBe(a.order.id);
        expect(await orderCount()).toBe(1);
    }, 60000);
});
