import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// The complete autonomous paper loop against real Postgres and the real
// Phase 1 engine. Only the market feed and the LLM are simulated.

describe.skipIf(!TEST_DB || !TEST_REDIS)("autonomous paper runtime", () => {
    let pool, engine, reconcile, AutonomousRuntime, MODE, PaperVenue, VENUE_BEHAVIOUR, STATES;
    let scanUniverse, screenSymbol;
    const USER = 6161;
    const CASH = 100_000_000;
    const PRICE = 100_000;

    const asOf = new Date(Date.UTC(2026, 8, 1, 6, 30));   // Tue 12:00 IST
    const bar = (close, volume = 1000) => ({
        ts: asOf.toISOString(), close, high: close + 1, low: close - 1, volume });
    const calm = (n = 40, base = 100) =>
        Array.from({ length: n }, (_, i) => bar(base + (i % 2 ? -0.05 : 0.05), 1000));

    beforeEach(async () => {
        ({ pool } = await import("../config/db.js"));
        engine = await import("../services/execution/engine.js");
        reconcile = await import("../services/execution/reconcile.js");
        ({ AutonomousRuntime, MODE } = await import("../services/autonomous/runtime.js"));
        ({ PaperVenue, VENUE_BEHAVIOUR } = await import("../services/execution/paperVenue.js"));
        ({ STATES } = await import("../services/execution/states.js"));
        ({ scanUniverse, screenSymbol } = await import("../services/autonomous/candidates.js"));

        await pool.query("DELETE FROM position_events WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM order_reconciliations WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'runtime@test',$2)
             ON CONFLICT (id) DO UPDATE SET balance_paise=$2`, [USER, CASH]);
    });

    afterAll(async () => { if (pool) await pool.end(); });

    const holding = async (symbol) => {
        const { rows } = await pool.query(
            "SELECT quantity FROM portfolio WHERE user_id=$1 AND symbol=$2", [USER, symbol]);
        return rows.length ? Number(rows[0].quantity) : 0;
    };
    const orderCount = async () => {
        const { rows } = await pool.query("SELECT COUNT(*)::int n FROM orders WHERE user_id=$1", [USER]);
        return rows[0].n;
    };

    const basePorts = (over = {}) => ({
        loadPositions: async () => [],
        loadPortfolio: async () => ({
            userId: USER, cashPaise: CASH, positionCount: 0,
            grossExposurePaise: 0, netExposurePaise: 0, unrealisedPnlPaise: 0, positions: [] }),
        loadObservations: async () => [],
        recordEvent: vi.fn(async (e) => ({ id: `ev-${e.key}` })),
        journal: vi.fn(async () => ({})),
        sessionCounters: async () => ({ trades: 0, turnoverPaise: 0, realisedLossPaise: 0 }),
        ambiguousOrderCount: async () => 0,
        ...over,
    });

    const makeRuntime = (over = {}, venueScript = {}) => new AutonomousRuntime({
        engine, reconciler: reconcile, userId: USER, clock: () => asOf,
        ports: basePorts(over), venueScript,
    });

    describe("paper-only safety", () => {
        it("refuses to construct in live mode", () => {
            expect(() => new AutonomousRuntime({
                engine, reconciler: reconcile, ports: basePorts(), mode: MODE.LIVE }))
                .toThrow(/paper only/);
        });

        it("reports live execution as disabled", () => {
            expect(makeRuntime().health().liveExecutionEnabled).toBe(false);
        });
    });

    describe("candidate lifecycle: screen to entry", () => {
        const movers = () => [{
            symbol: "RELIANCE", price: 103,
            bars1m: [...calm(40, 100), bar(103, 5000)],
            bars5m: [...calm(10, 100), bar(103, 5000)],
            bars15m: [...calm(10, 100), bar(103, 5000)],
        }];

        it("screens deterministically and does not trade on the screen alone", async () => {
            const analyse = vi.fn(async () => ({ action: "HOLD", confidence: "LOW" }));
            const runtime = makeRuntime({
                loadObservations: async () => movers(), analyseCandidate: analyse });
            await runtime.candidateScan();
            expect(analyse).toHaveBeenCalled();
            expect(await orderCount()).toBe(0);   // screen fired, nothing traded
        });

        it("a BUY decision passes risk and opens a real paper position", async () => {
            const recordThesis = vi.fn(async () => ({ id: null }));
            const runtime = makeRuntime({
                loadObservations: async () => movers(),
                analyseCandidate: async () => ({ action: "BUY", confidence: "HIGH", quantity: 200 }),
                recordThesis,
            });
            await runtime.candidateScan();
            expect(recordThesis).toHaveBeenCalled();       // thesis before the order
            expect(await holding("RELIANCE")).toBe(200);
            expect(runtime.health().runtime.entriesOpened).toBe(1);
        });

        it("risk rejection prevents the order entirely", async () => {
            const runtime = makeRuntime({
                loadObservations: async () => movers(),
                loadPortfolio: async () => ({
                    userId: USER, cashPaise: 100, positionCount: 0,
                    grossExposurePaise: 0, netExposurePaise: 0, unrealisedPnlPaise: 0, positions: [] }),
                analyseCandidate: async () => ({ action: "BUY", confidence: "HIGH", quantity: 10 }),
            });
            await runtime.candidateScan();
            expect(await orderCount()).toBe(0);
            expect(await holding("RELIANCE")).toBe(0);
        });

        it("excludes held symbols from discovery", () => {
            const result = scanUniverse({
                observations: movers(), heldSymbols: new Set(["RELIANCE"]), asOf, calculatedAt: asOf });
            expect(result.candidates).toHaveLength(0);
            expect(result.examined[0].reasons).toContain("already held");
        });

        it("caps candidates per cycle so a volatile session cannot unbound the LLM budget", () => {
            const many = Array.from({ length: 30 }, (_, i) => ({
                symbol: `S${i}`, price: 103,
                bars1m: [...calm(40, 100), bar(103 + i * 0.01, 5000)],
                bars5m: [...calm(10, 100), bar(103 + i * 0.01, 5000)],
                bars15m: [...calm(10, 100), bar(103 + i * 0.01, 5000)],
            }));
            const result = scanUniverse({ observations: many, asOf, calculatedAt: asOf });
            expect(result.candidates.length).toBeLessThanOrEqual(5);
            expect(result.suppressed).toBeGreaterThan(0);
        });

        it("a quiet universe produces no candidate and no reasoning", async () => {
            const analyse = vi.fn();
            const runtime = makeRuntime({
                loadObservations: async () => [{
                    symbol: "FLAT", price: 100,
                    bars1m: calm(41), bars5m: calm(11), bars15m: calm(11) }],
                analyseCandidate: analyse,
            });
            await runtime.candidateScan();
            expect(analyse).not.toHaveBeenCalled();
        });

        it("a stale observation cannot become a candidate", () => {
            const [obs] = movers();
            const result = scanUniverse({
                observations: [{ ...obs, stale: true }], asOf, calculatedAt: asOf });
            expect(result.candidates).toHaveLength(0);
        });

        it("screening is deterministic", () => {
            const build = () => JSON.stringify(scanUniverse({
                observations: movers(), asOf, calculatedAt: asOf }).examined);
            const first = build();
            for (let i = 0; i < 20; i += 1) expect(build()).toBe(first);
        });
    });

    describe("paper venue behaviours", () => {
        const intent = (over = {}) => ({
            userId: USER, symbol: "TCS", side: "BUY", quantity: 30, pricePaise: PRICE,
            clientOrderId: `venue-${Math.random()}`, correlationId: "v-1", ...over });

        it("fills immediately by default and updates the position", async () => {
            const venue = new PaperVenue({ engine });
            const { order } = await venue.submit(intent());
            expect(order.state).toBe(STATES.FILLED);
            expect(await holding("TCS")).toBe(30);
        });

        it("partially fills, then completes on a later tick", async () => {
            const venue = new PaperVenue({
                engine, script: { TCS: VENUE_BEHAVIOUR.PARTIAL_THEN_COMPLETE } });
            const { order } = await venue.submit(intent());
            expect(order.state).toBe(STATES.PARTIALLY_FILLED);
            expect(Number(order.filled_quantity)).toBe(10);
            await venue.tick();
            const done = await engine.getOrder(order.id);
            expect(done.state).toBe(STATES.FILLED);
            expect(await holding("TCS")).toBe(30);
        });

        it("a stalled partial keeps its remaining reservation", async () => {
            const venue = new PaperVenue({
                engine, script: { TCS: VENUE_BEHAVIOUR.PARTIAL_THEN_STALL } });
            const { order } = await venue.submit(intent());
            await venue.tick();
            const still = await engine.getOrder(order.id);
            expect(still.state).toBe(STATES.PARTIALLY_FILLED);
            expect(Number(still.reserved_paise)).toBeGreaterThan(0);
        });

        it("delays a fill to a later tick rather than filling on submit", async () => {
            const venue = new PaperVenue({ engine, script: { TCS: VENUE_BEHAVIOUR.DELAYED_FILL } });
            const { order } = await venue.submit(intent());
            expect(order.state).toBe(STATES.WORKING);
            expect(await holding("TCS")).toBe(0);
            await venue.tick();
            expect((await engine.getOrder(order.id)).state).toBe(STATES.FILLED);
        });

        it("rejects without touching cash or position", async () => {
            const venue = new PaperVenue({ engine, script: { TCS: VENUE_BEHAVIOUR.REJECT } });
            const { order } = await venue.submit(intent());
            expect(order.state).toBe(STATES.REJECTED);
            expect(Number(order.reserved_paise)).toBe(0);
            expect(await holding("TCS")).toBe(0);
        });

        it("cancels and expires cleanly", async () => {
            const c = new PaperVenue({ engine, script: { TCS: VENUE_BEHAVIOUR.CANCEL } });
            const { order: cancelled } = await c.submit(intent());
            expect(cancelled.state).toBe(STATES.CANCELLED);

            const e = new PaperVenue({ engine, script: { TCS: VENUE_BEHAVIOUR.EXPIRE } });
            const { order: expired } = await e.submit(intent());
            expect(expired.state).toBe(STATES.EXPIRED);
            expect(expired.rejection_reason).toBeNull();   // expiry is not a rejection
        });

        it("absorbs a duplicate acknowledgement", async () => {
            const venue = new PaperVenue({ engine, script: { TCS: VENUE_BEHAVIOUR.DUPLICATE_ACK } });
            const { order } = await venue.submit(intent());
            expect(order.state).toBe(STATES.FILLED);
            expect(venue.health().duplicateAcks).toBe(1);
        });

        it("absorbs a duplicate fill without double counting", async () => {
            const venue = new PaperVenue({ engine, script: { TCS: VENUE_BEHAVIOUR.DUPLICATE_FILL } });
            const { order } = await venue.submit(intent());
            expect(venue.health().duplicateFills).toBe(1);
            expect(Number(order.filled_quantity)).toBe(30);
            expect(await holding("TCS")).toBe(30);
        });

        it("a silent venue leaves the order unresolved, and reconciliation makes it AMBIGUOUS", async () => {
            const venue = new PaperVenue({ engine, script: { TCS: VENUE_BEHAVIOUR.SILENT } });
            const { order } = await venue.submit(intent());
            expect(order.state).toBe(STATES.NEW);
            const external = await venue.externalStateOf(order);
            expect(external).toBeNull();
            const result = await reconcile.reconcileOrder(order.id, external);
            expect(result.outcome).toBe(reconcile.OUTCOME.AMBIGUOUS);
            expect(result.order.state).toBe(STATES.AMBIGUOUS);
        });

        it("a duplicate submission produces one order", async () => {
            const venue = new PaperVenue({ engine });
            const fixed = intent({ clientOrderId: "fixed-1" });
            const a = await venue.submit(fixed);
            const b = await venue.submit(fixed);
            expect(b.duplicate).toBe(true);
            expect(b.order.id).toBe(a.order.id);
            expect(await holding("TCS")).toBe(30);
        });
    });

    describe("idempotency across the runtime", () => {
        const movers = () => [{
            symbol: "INFY", price: 103,
            bars1m: [...calm(40, 100), bar(103, 5000)],
            bars5m: [...calm(10, 100), bar(103, 5000)],
            bars15m: [...calm(10, 100), bar(103, 5000)] }];

        it("repeating a candidate scan does not open a second position", async () => {
            let n = 0;
            const runtime = makeRuntime({
                loadObservations: async () => movers(),
                // A stable correlation id models the same decision recurring.
                analyseCandidate: async () => ({ action: "BUY", confidence: "HIGH", quantity: 200 }),
                recordThesis: async () => ({ id: null }),
            });
            // Force a stable client order id by pinning the correlation id.
            runtime.executeIntent = async (intent) =>
                runtime.venue.submit({ ...intent, userId: USER,
                                       clientOrderId: `stable:${intent.symbol}` });
            await runtime.candidateScan();
            const after = await orderCount();
            await runtime.candidateScan();
            expect(await orderCount()).toBe(after);
            expect(await holding("INFY")).toBe(200);
        });
    });

    describe("restart and recovery", () => {
        it("restart with an open position recovers it", async () => {
            const venue = new PaperVenue({ engine });
            await venue.submit({ userId: USER, symbol: "WIPRO", side: "BUY", quantity: 8,
                                 pricePaise: PRICE, clientOrderId: "r-1", correlationId: "r" });
            const runtime = makeRuntime();
            await runtime.start();
            expect(runtime.health().orchestrator.recovery.positions).toBeDefined();
            expect(await holding("WIPRO")).toBe(8);
            await runtime.stop();
        });

        it("restart with a partial fill recovers the remaining obligation", async () => {
            const venue = new PaperVenue({
                engine, script: { SBIN: VENUE_BEHAVIOUR.PARTIAL_THEN_STALL } });
            const { order } = await venue.submit({
                userId: USER, symbol: "SBIN", side: "BUY", quantity: 30,
                pricePaise: PRICE, clientOrderId: "r-2", correlationId: "r" });
            const runtime = makeRuntime();
            await runtime.start();
            const open = await engine.openOrders(USER);
            const found = open.find((o) => o.id === order.id);
            expect(found.state).toBe(STATES.PARTIALLY_FILLED);
            expect(Number(found.reserved_paise)).toBeGreaterThan(0);
            await runtime.stop();
        });

        it("restart with an ambiguous order surfaces it and blocks new exposure", async () => {
            const venue = new PaperVenue({ engine, script: { ITC: VENUE_BEHAVIOUR.SILENT } });
            const { order } = await venue.submit({
                userId: USER, symbol: "ITC", side: "BUY", quantity: 5,
                pricePaise: PRICE, clientOrderId: "r-3", correlationId: "r" });
            await reconcile.reconcileOrder(order.id, null);

            const runtime = makeRuntime();
            await runtime.start();
            expect(runtime.health().orchestrator.recovery.ambiguousOrders).toBe(1);
            expect(await reconcile.hasUnresolvedAmbiguity(USER)).toBe(true);
            await runtime.stop();
        });

        it("restarting twice does not duplicate anything", async () => {
            const venue = new PaperVenue({ engine });
            await venue.submit({ userId: USER, symbol: "HDFCBANK", side: "BUY", quantity: 4,
                                 pricePaise: PRICE, clientOrderId: "r-4", correlationId: "r" });
            const before = await orderCount();
            for (let i = 0; i < 3; i += 1) {
                const runtime = makeRuntime();
                await runtime.start();
                await runtime.stop();
            }
            expect(await orderCount()).toBe(before);
            expect(await holding("HDFCBANK")).toBe(4);
        });
    });

    describe("scheduler ownership", () => {
        it("registers every autonomous job on the one scheduler", async () => {
            const runtime = makeRuntime();
            const names = runtime.orchestrator.scheduler.health().jobs.map((j) => j.name).sort();
            expect(names).toEqual([
                "candidate-scan", "health", "news-ingest", "order-expiry",
                "pending-sweep", "position-monitor", "reasoning", "reconciliation",
                "stale-sweep", "venue-tick",
            ]);
        });

        it("survives a failing job", async () => {
            const runtime = makeRuntime({
                loadObservations: async () => { throw new Error("feed down"); } });
            await runtime.start();
            const result = await runtime.orchestrator.scheduler.runJobOnce("candidate-scan");
            expect(result.ok).toBe(false);
            expect(runtime.orchestrator.scheduler.health().running).toBe(true);
            await runtime.stop();
        });

        it("suppresses discovery outside a permitted session", async () => {
            const closed = new Date(Date.UTC(2026, 8, 1, 14, 0));   // 19:30 IST
            const analyse = vi.fn();
            const runtime = new AutonomousRuntime({
                engine, reconciler: reconcile, userId: USER, clock: () => closed,
                ports: basePorts({ analyseCandidate: analyse,
                                   loadObservations: async () => [] }),
            });
            await runtime.start();
            const result = await runtime.orchestrator.scheduler.runJobOnce("candidate-scan");
            expect(result.skipped).toBe("not-permitted");
            await runtime.stop();
        });
    });

    describe("observability", () => {
        it("reports mode, venue, scheduler, queue and runtime counters", async () => {
            const runtime = makeRuntime();
            await runtime.start();
            const h = runtime.health();
            expect(h.mode).toBe("PAPER");
            expect(h.liveExecutionEnabled).toBe(false);
            expect(h.venue).toHaveProperty("resting");
            expect(h.orchestrator.scheduler.jobCount).toBe(10);
            expect(h.orchestrator).toHaveProperty("queue");
            expect(h.runtime).toHaveProperty("candidatesScanned");
            await runtime.stop();
        });
    });
});
