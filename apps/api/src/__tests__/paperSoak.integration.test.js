import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// A controlled paper soak: a simulated session driven cycle by cycle, with
// quiet periods and material events, measured end to end.
//
// Deterministic by construction (fixed clock, scripted market), so a failure
// is reproducible rather than a flake.

describe.skipIf(!TEST_DB || !TEST_REDIS)("paper autonomous soak", () => {
    let pool, engine, reconcile, AutonomousRuntime;
    const USER = 5252;
    const CASH = 500_000_000;

    // The market-wide detector refuses to generalise from fewer than 10
    // symbols, so a realistic soak needs a universe at least that size.
    const SYMBOLS = ["RELIANCE", "TCS", "INFY", "SBIN", "WIPRO", "ITC",
                     "HDFCBANK", "ICICIBANK", "LT", "AXISBANK", "MARUTI", "TITAN"];
    const SESSION_START = Date.UTC(2026, 8, 1, 4, 0);   // 09:30 IST, Tuesday
    const CYCLE_MS = 60_000;
    const CYCLES = 60;                                   // one simulated hour

    beforeEach(async () => {
        ({ pool } = await import("../config/db.js"));
        engine = await import("../services/execution/engine.js");
        reconcile = await import("../services/execution/reconcile.js");
        ({ AutonomousRuntime } = await import("../services/autonomous/runtime.js"));

        await pool.query("DELETE FROM position_events WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM order_reconciliations WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'soak@test',$2)
             ON CONFLICT (id) DO UPDATE SET balance_paise=$2`, [USER, CASH]);
    });

    afterAll(async () => { if (pool) await pool.end(); });

    // A scripted session: calm, one shock at cycle 20, calm, a market-wide
    // move at cycle 40, then calm again.
    const priceAt = (symbol, cycle) => {
        const base = 1000 + SYMBOLS.indexOf(symbol) * 10;
        const drift = Math.sin(cycle / 7 + SYMBOLS.indexOf(symbol)) * 0.4;
        if (cycle >= 20 && cycle < 23 && symbol === "RELIANCE") return base * 1.06;   // symbol shock
        if (cycle >= 40 && cycle < 43) return base * 0.965;                            // market-wide
        return base + drift;
    };

    const barsFor = (symbol, cycle, n = 45) =>
        Array.from({ length: n }, (_, i) => {
            const c = Math.max(0, cycle - (n - 1 - i));
            const close = priceAt(symbol, c);
            return { ts: new Date(SESSION_START + c * CYCLE_MS).toISOString(),
                     close, high: close * 1.001, low: close * 0.999, volume: 5000 };
        });

    it("runs a simulated session with quiet periods and material events", async () => {
        let cycle = 0;
        const now = () => new Date(SESSION_START + cycle * CYCLE_MS);

        const llmCalls = { candidate: 0, reassess: 0 };
        const recorded = new Set();

        const ports = {
            loadPositions: async () => {
                const { rows } = await pool.query(
                    "SELECT symbol, quantity, avg_price_paise FROM portfolio WHERE user_id=$1", [USER]);
                return rows.map((r) => ({
                    symbol: r.symbol, userId: USER, side: "BUY",
                    quantity: Number(r.quantity),
                    entryPricePaise: Number(r.avg_price_paise),
                    currentPricePaise: Math.round(priceAt(r.symbol, cycle) * 100),
                    exposurePaise: Number(r.quantity) * Math.round(priceAt(r.symbol, cycle) * 100),
                    stale: false, dataAgeMs: 1000, sessionPhase: "EARLY_SESSION",
                    thesisId: `t-${r.symbol}`, correlationId: `c-${r.symbol}`,
                    holdingSeconds: 600,
                    stopPaise: Math.round(Number(r.avg_price_paise) * 0.97),
                    targetPaise: Math.round(Number(r.avg_price_paise) * 1.05),
                    stopDistance: 1, targetDistance: 1, pnlPercent: 0,
                    unrealisedPnlPaise: 0, hasThesis: true,
                }));
            },
            loadPortfolio: async () => {
                const { rows } = await pool.query("SELECT balance_paise FROM users WHERE id=$1", [USER]);
                return { userId: USER, cashPaise: Number(rows[0].balance_paise), positionCount: 0,
                         grossExposurePaise: 0, netExposurePaise: 0, unrealisedPnlPaise: 0, positions: [] };
            },
            loadObservations: async () => SYMBOLS.map((symbol) => ({
                symbol, price: priceAt(symbol, cycle),
                bars1m: barsFor(symbol, cycle),
                bars5m: barsFor(symbol, cycle, 12),
                bars15m: barsFor(symbol, cycle, 12),
            })),
            positionFor: async (symbol) => (await ports.loadPositions()).find((p) => p.symbol === symbol) ?? null,
            loadThesis: async () => ({ id: "t-1", side: "BUY", entry_price_paise: 100000 }),
            recordEvent: async (e) => {
                if (recorded.has(e.key)) return null;
                recorded.add(e.key);
                return { id: e.key };
            },
            reassess: async () => { llmCalls.reassess += 1; return { action: "HOLD", confidence: "LOW" }; },
            analyseCandidate: async () => { llmCalls.candidate += 1; return { action: "HOLD", confidence: "LOW" }; },
            intentFrom: () => null,
            evaluateRisk: async () => ({ decision: "ALLOW" }),
            journal: async () => ({}),
            sessionCounters: async () => ({ trades: 0, turnoverPaise: 0, realisedLossPaise: 0 }),
        };

        const runtime = new AutonomousRuntime({
            engine, reconciler: reconcile, userId: USER, clock: now, ports });
        await runtime.start();

        const observed = { anomalyCycles: 0, marketWideCycles: 0, queuePeak: 0 };

        for (cycle = 0; cycle < CYCLES; cycle += 1) {
            const before = runtime.orchestrator.health().metrics.anomaliesDetected;
            await runtime.orchestrator.monitorCycle();
            const after = runtime.orchestrator.health().metrics.anomaliesDetected;
            if (after > before) observed.anomalyCycles += 1;

            observed.queuePeak = Math.max(observed.queuePeak, runtime.orchestrator.queue.size);
            await runtime.orchestrator.reasoningCycle();

            if (cycle % 10 === 0) await runtime.candidateScan();
            if (cycle % 15 === 0) await runtime.reconcile();
            await runtime.venue.tick();
        }

        observed.marketWideCycles = runtime.orchestrator.health().metrics.marketWideAnomalies;
        await runtime.stop();

        const health = runtime.health();

        // The session actually happened.
        expect(health.orchestrator.metrics.cycles).toBe(CYCLES);
        expect(observed.anomalyCycles).toBeGreaterThan(0);      // material events fired
        expect(observed.marketWideCycles).toBeGreaterThan(0);   // the market-wide move fired

        // Cost control: reasoning is far rarer than observation. Sixty cycles
        // over five symbols is 300 observations; anything close to that many
        // LLM calls would mean the gating is not working.
        const totalLlm = llmCalls.candidate + llmCalls.reassess;
        expect(totalLlm).toBeLessThan(CYCLES);
        expect(health.orchestrator.metrics.reasoningAvoided).toBeGreaterThan(0);

        // Backpressure held.
        expect(observed.queuePeak).toBeLessThanOrEqual(runtime.orchestrator.queue.capacity);

        // Nothing unsafe happened: every decision was HOLD, so no order exists.
        const { rows } = await pool.query("SELECT COUNT(*)::int n FROM orders WHERE user_id=$1", [USER]);
        expect(rows[0].n).toBe(0);

        // The scheduler stayed healthy throughout.
        expect(health.orchestrator.scheduler.jobs.every((j) => j.failures === 0)).toBe(true);
    }, 120000);

    it("a soak with entries opens positions and keeps accounting consistent", async () => {
        let cycle = 0;
        const now = () => new Date(SESSION_START + cycle * CYCLE_MS);
        let bought = false;

        const ports = {
            loadPositions: async () => [],
            loadPortfolio: async () => {
                const { rows } = await pool.query("SELECT balance_paise FROM users WHERE id=$1", [USER]);
                return { userId: USER, cashPaise: Number(rows[0].balance_paise), positionCount: 0,
                         grossExposurePaise: 0, netExposurePaise: 0, unrealisedPnlPaise: 0, positions: [] };
            },
            loadObservations: async () => [{
                symbol: "RELIANCE", price: priceAt("RELIANCE", cycle),
                bars1m: barsFor("RELIANCE", cycle),
                bars5m: barsFor("RELIANCE", cycle, 12),
                bars15m: barsFor("RELIANCE", cycle, 12),
            }],
            recordEvent: async (e) => ({ id: e.key }),
            analyseCandidate: async () => {
                if (bought) return { action: "HOLD", confidence: "LOW" };
                bought = true;
                return { action: "BUY", confidence: "HIGH", quantity: 100 };
            },
            recordThesis: async () => ({ id: null }),
            journal: async () => ({}),
            sessionCounters: async () => ({ trades: 0, turnoverPaise: 0, realisedLossPaise: 0 }),
        };

        const runtime = new AutonomousRuntime({
            engine, reconciler: reconcile, userId: USER, clock: now, ports });
        await runtime.start();

        for (cycle = 20; cycle < 30; cycle += 1) {
            await runtime.candidateScan();
            await runtime.venue.tick();
        }
        await runtime.stop();

        const { rows: pos } = await pool.query(
            "SELECT quantity FROM portfolio WHERE user_id=$1 AND symbol='RELIANCE'", [USER]);
        const { rows: ord } = await pool.query(
            "SELECT COUNT(*)::int n FROM orders WHERE user_id=$1", [USER]);

        expect(Number(pos[0].quantity)).toBe(100);
        expect(ord[0].n).toBe(1);            // one entry, not ten
        expect(runtime.health().runtime.entriesOpened).toBe(1);

        // Cash and fills reconcile.
        const { rows: check } = await pool.query(
            `SELECT o.filled_quantity, COALESCE(SUM(f.quantity),0) AS fills
             FROM orders o LEFT JOIN order_fills f ON f.order_id=o.id
             WHERE o.user_id=$1 GROUP BY o.id, o.filled_quantity`, [USER]);
        for (const row of check) {
            expect(Number(row.filled_quantity)).toBe(Number(row.fills));
        }
    }, 120000);
});
