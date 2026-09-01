import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// The whole autonomous path, end to end, with only the market feed and the LLM
// faked. Real orchestrator, real monitor, real event queue, real risk gate,
// real Phase 1 execution engine, real Postgres.

describe.skipIf(!TEST_DB || !TEST_REDIS)("autonomous loop end to end", () => {
    let pool, redis, engine, reconcile, Orchestrator, ConnectionTracker, CONNECTION;
    let evaluateRisk, intentFrom, buildPositionState;
    const USER = 9090;
    const CASH = 100_000_000;
    const SYMBOL = "RELIANCE";
    const PRICE = 100_000;

    beforeEach(async () => {
        ({ pool } = await import("../config/db.js"));
        ({ default: redis } = await import("../config/redis.js"));
        engine = await import("../services/execution/engine.js");
        reconcile = await import("../services/execution/reconcile.js");
        ({ Orchestrator } = await import("../services/orchestrator/orchestrator.js"));
        ({ ConnectionTracker, CONNECTION } = await import("../services/orchestrator/connectionState.js"));
        ({ evaluate: evaluateRisk } = await import("../services/autonomous/riskGate.js"));
        ({ intentFrom } = await import("../services/autonomous/loop.js"));
        ({ buildPositionState } = await import("../services/autonomous/positionState.js"));

        // Event keys are deterministic under a fixed clock, so they survive
        // between runs and would deduplicate the very event a test needs.
        await pool.query("DELETE FROM position_events WHERE user_id=$1", [USER]);
        // Cooldowns are durable now, so a symbol priced by one test would
        // otherwise be skipped by the next.
        await pool.query("DELETE FROM candidate_cooldowns WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM order_reconciliations WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'e2e@test',$2)
             ON CONFLICT (id) DO UPDATE SET balance_paise=$2`, [USER, CASH]);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const holding = async () => {
        const { rows } = await pool.query(
            "SELECT quantity FROM portfolio WHERE user_id=$1 AND symbol=$2", [USER, SYMBOL]);
        return rows.length ? Number(rows[0].quantity) : 0;
    };
    const orderCount = async () => {
        const { rows } = await pool.query("SELECT COUNT(*)::int n FROM orders WHERE user_id=$1", [USER]);
        return rows[0].n;
    };

    // Open a real position through the Phase 1 engine.
    const openPosition = async (quantity = 10) => {
        const { order } = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side: "BUY", quantity, pricePaise: PRICE,
            clientOrderId: `e2e-open-${Date.now()}`, correlationId: "e2e-open",
        });
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        await engine.applyFill({
            orderId: order.id, executionRef: "fill-1", quantity, pricePaise: PRICE });
        return order;
    };

    // 2026-09-01 is a Tuesday; 12:00 IST is inside the OPEN session.
    const marketOpenAt = new Date(Date.UTC(2026, 8, 1, 6, 30));

    const buildLoop = ({ tickPrice, modelAction = "EXIT", journal = vi.fn(async () => ({})) }) => {
        const connection = new ConnectionTracker({ clock: () => marketOpenAt.getTime() });
        connection.onConnecting(); connection.onConnected();
        connection.onTick(marketOpenAt.getTime());

        const positionFrom = () => buildPositionState({
            holding: { user_id: USER, symbol: SYMBOL, quantity: 10, avg_price_paise: PRICE },
            thesis: {
                id: "t-e2e", correlation_id: "e2e-corr", side: "BUY",
                opened_at: new Date(marketOpenAt.getTime() - 3600_000).toISOString(),
                stop_paise: 95_000, target_paise: 110_000,
            },
            tick: { price: tickPrice, timestamp: marketOpenAt.toISOString() },
            now: marketOpenAt,
        });

        const callModel = vi.fn(async () => ({
            action: modelAction, confidence: "HIGH", thesisStillValid: false,
            whatChanged: "stop breached", material: true,
            reasoning: "the recorded invalidation triggered", evidence: [],
        }));

        const ports = {
            loadPositions: async () => [positionFrom()],
            positionFor: async () => positionFrom(),
            loadPortfolio: async () => ({
                userId: USER, cashPaise: CASH, positionCount: 1,
                grossExposurePaise: 1_000_000, netExposurePaise: 1_000_000,
                unrealisedPnlPaise: 0,
                positions: [{ symbol: SYMBOL, quantity: 10, exposurePaise: 1_000_000 }],
            }),
            loadThesis: async () => ({ id: "t-e2e", side: "BUY", entry_price_paise: PRICE }),
            recordEvent: async (e) => {
                const { rows } = await pool.query(
                    `INSERT INTO position_events
                       (event_key, event_type, severity, symbol, user_id, correlation_id,
                        source, observed, reason, observed_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
                     ON CONFLICT (event_key) DO NOTHING RETURNING id`,
                    [e.key, e.type, e.severity, e.symbol, USER, e.correlationId,
                     e.source, JSON.stringify(e.observed), e.reason, e.observedAt]);
                return rows[0] ?? null;   // null => already handled
            },
            reassess: async ({ position, thesis, event }) => {
                const { reassessPosition } = await import("../services/autonomous/reassess.js");
                return reassessPosition({ position, thesis, event, callModel });
            },
            intentFrom,
            evaluateRisk: async (intent) => evaluateRisk(intent, {
                portfolio: await ports.loadPortfolio(),
                nowMs: marketOpenAt.getTime(), stale: !connection.isTrusted(),
                session: { trades: 0, turnoverPaise: 0, realisedLossPaise: 0 },
                // Read from the database, like the live ports do, so the
                // ambiguity block below is exercised rather than assumed.
                ambiguousOrders: Number((await pool.query(
                    "SELECT COUNT(*)::int n FROM orders WHERE user_id=$1 AND state='AMBIGUOUS'",
                    [USER])).rows[0].n),
            }),
            execute: async (intent) => {
                const { order } = await engine.submitOrder({
                    userId: USER, symbol: intent.symbol, side: intent.side,
                    quantity: intent.quantity, pricePaise: intent.pricePaise,
                    clientOrderId: intent.clientOrderId, correlationId: intent.correlationId,
                });
                if (order.state === "NEW") {
                    await engine.acceptOrder(order.id);
                    await engine.workOrder(order.id);
                    await engine.applyFill({
                        orderId: order.id, executionRef: `exec-${order.id}`,
                        quantity: intent.quantity, pricePaise: intent.pricePaise });
                }
                return order;
            },
            journal,
            openOrders: () => engine.openOrders(USER),
            reconcileAll: async () => [],
            expireStaleOrders: async () => [],
        };

        return { ports, connection, callModel, journal,
                 orch: new Orchestrator({ ports, clock: () => marketOpenAt }) };
    };

    it("drives market data through to a real paper fill and journals it", async () => {
        await openPosition(10);
        expect(await holding()).toBe(10);
        const ordersBefore = await orderCount();

        const { orch, callModel, journal } = buildLoop({ tickPrice: 940 }); // below the 950 stop
        await orch.start();
        await orch.monitorCycle();
        expect(orch.queue.size).toBe(1);

        await orch.reasoningCycle();

        expect(callModel).toHaveBeenCalledOnce();
        expect(await orderCount()).toBe(ordersBefore + 1);
        expect(await holding()).toBe(0);            // exited
        expect(journal).toHaveBeenCalledWith(expect.objectContaining({ executed: true }));
        await orch.stop();
    });

    it("the same event repeated creates no second action", async () => {
        await openPosition(10);
        const { orch } = buildLoop({ tickPrice: 940 });
        await orch.start();

        await orch.monitorCycle();
        await orch.reasoningCycle();
        const afterFirst = await orderCount();

        await orch.monitorCycle();   // identical condition, same event key
        await orch.reasoningCycle();

        expect(await orderCount()).toBe(afterFirst);
        await orch.stop();
    });

    it("a quiet position produces no event, no model call and no order", async () => {
        await openPosition(10);
        const before = await orderCount();
        const { orch, callModel } = buildLoop({ tickPrice: 1000 }); // at entry
        await orch.start();
        await orch.monitorCycle();
        await orch.reasoningCycle();
        expect(orch.queue.size).toBe(0);
        expect(callModel).not.toHaveBeenCalled();
        expect(await orderCount()).toBe(before);
        await orch.stop();
    });

    it("stale market data blocks the action even when the model says EXIT", async () => {
        await openPosition(10);
        const before = await orderCount();
        const { orch, connection } = buildLoop({ tickPrice: 940 });
        // The feed goes silent: the monitor sees a stale position and emits
        // DATA_STALE rather than a tradable event.
        connection.onDisconnected("feed lost");
        expect(connection.isTrusted()).toBe(false);

        const stalePorts = {
            ...orch.ports,
            loadPositions: async () => [{
                ...(await orch.ports.loadPositions())[0], stale: true, dataAgeMs: 300_000,
            }],
        };
        const staleOrch = new Orchestrator({ ports: stalePorts, clock: () => marketOpenAt });
        await staleOrch.monitorCycle();
        await staleOrch.reasoningCycle();
        expect(await orderCount()).toBe(before);
        expect(await holding()).toBe(10);
    });

    it("a malformed model response executes nothing", async () => {
        await openPosition(10);
        const before = await orderCount();
        const { orch } = buildLoop({ tickPrice: 940, modelAction: "SELL EVERYTHING" });
        await orch.monitorCycle();
        await orch.reasoningCycle();
        expect(await orderCount()).toBe(before);
        expect(await holding()).toBe(10);
    });

    it("restart with an open position recovers and does not duplicate", async () => {
        await openPosition(10);
        const { orch } = buildLoop({ tickPrice: 940 });
        await orch.start();
        await orch.monitorCycle();
        await orch.reasoningCycle();
        const afterFirst = await orderCount();
        await orch.stop();

        // A new orchestrator over the same persisted state: a restart.
        const restarted = buildLoop({ tickPrice: 940 });
        await restarted.orch.start();
        expect(restarted.orch.health().recovery).toBeDefined();
        await restarted.orch.monitorCycle();
        await restarted.orch.reasoningCycle();
        expect(await orderCount()).toBe(afterFirst);   // event key already stored
        await restarted.orch.stop();
    });

    it("restart with an AMBIGUOUS order surfaces it and blocks new exposure", async () => {
        const { order } = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side: "BUY", quantity: 5, pricePaise: PRICE,
            clientOrderId: "e2e-amb", correlationId: "e2e" });
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        await reconcile.reconcileOrder(order.id, null);   // venue unreachable

        const { orch, ports } = buildLoop({ tickPrice: 1000 });
        await orch.start();
        expect(orch.health().recovery.ambiguousOrders).toBe(1);
        expect(await reconcile.hasUnresolvedAmbiguity(USER)).toBe(true);

        // And it actually blocks. This assertion is the point of the test: the
        // boot log had claimed exposure was blocked while nothing enforced it,
        // so an order of unknown outcome sat there while the system opened more.
        const probe = {
            action: "BUY", side: "BUY", symbol: SYMBOL, quantity: 20,
            pricePaise: PRICE, referencePricePaise: PRICE,
        };
        const blocked = await ports.evaluateRisk(probe);
        expect(blocked.decision).toBe("REJECT");
        expect(blocked.code).toBe("UNRESOLVED_AMBIGUITY");

        // Closing what we already hold stays possible. A limit that stops you
        // reducing is a limit that traps you.
        const exit = await ports.evaluateRisk({
            action: "EXIT", side: "SELL", symbol: SYMBOL, quantity: 10,
            pricePaise: PRICE, referencePricePaise: PRICE,
        });
        expect(exit.decision).toBe("ALLOW");

        // Once reconciliation resolves it, exposure is permitted again.
        await engine.resolveTo(order.id, "CANCELLED");
        expect((await ports.evaluateRisk(probe)).decision).toBe("ALLOW");

        await orch.stop();
    });

    it("restart after a partial fill recovers the remaining obligation", async () => {
        const { order } = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side: "BUY", quantity: 100, pricePaise: PRICE,
            clientOrderId: "e2e-partial", correlationId: "e2e" });
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        await engine.applyFill({ orderId: order.id, executionRef: "p1", quantity: 40, pricePaise: PRICE });

        const { orch } = buildLoop({ tickPrice: 1000 });
        await orch.start();
        const open = await engine.openOrders(USER);
        const recovered = open.find((o) => o.client_order_id === "e2e-partial");
        expect(recovered.state).toBe("PARTIALLY_FILLED");
        expect(Number(recovered.filled_quantity)).toBe(40);
        expect(Number(recovered.reserved_paise)).toBeGreaterThan(0);
        await orch.stop();
    });
});
