import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// Reconciliation for the full chain: AI decision -> revalidation -> risk gate ->
// intent -> paper order -> position -> cash -> journal. Real Postgres, real
// execution engine, real risk gate, real orchestrator. Only the model is
// injected, because the model is the only part that is not deterministic.

describe.skipIf(!TEST_DB || !TEST_REDIS)("autonomous execution reconciliation", () => {
    let pool, redis, paperExecutor, orderForClientId, DECISION;
    let Orchestrator, reassessPosition, intentFrom, evaluateRisk, makeEvent;
    const SYMBOLS = ["RELIANCE", "TCS", "INFY", "WIPRO", "SBIN", "ITC", "HDFCBANK"];
    const USER = 4242;
    const START_CASH = 100_000_000; // Rs 10,00,000

    beforeEach(async () => {
        ({ pool } = await import("../config/db.js"));
        ({ default: redis } = await import("../config/redis.js"));
        // The engine validates price data and refuses to fill without it, so a
        // live-cache entry is part of the fixture, not a convenience.
        for (const symbol of SYMBOLS) {
            await redis.set(`stock:${symbol}`, JSON.stringify({
                symbol, price: 1000, volume: 100000,
                timestamp: new Date().toISOString(),
            }));
        }
        ({ paperExecutor, orderForClientId } = await import("../services/autonomous/execution.js"));
        ({ intentFrom } = await import("../services/autonomous/loop.js"));
        ({ DECISION, evaluate: evaluateRisk } =
            await import("../services/autonomous/riskGate.js"));
        ({ Orchestrator } = await import("../services/orchestrator/orchestrator.js"));
        ({ reassessPosition } = await import("../services/autonomous/reassess.js"));
        ({ makeEvent } = await import("../services/autonomous/events.js"));

        await pool.query("DELETE FROM orders WHERE user_id = $1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id = $1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1, 'auto-exec@test', $2)
             ON CONFLICT (id) DO UPDATE SET balance_paise = $2`, [USER, START_CASH]);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const cash = async () => {
        const { rows } = await pool.query("SELECT balance_paise FROM users WHERE id=$1", [USER]);
        return Number(rows[0].balance_paise);
    };
    const holding = async (symbol) => {
        const { rows } = await pool.query(
            "SELECT quantity, avg_price_paise FROM portfolio WHERE user_id=$1 AND symbol=$2",
            [USER, symbol]);
        return rows[0] ? { quantity: Number(rows[0].quantity),
                           avgPricePaise: Number(rows[0].avg_price_paise) } : null;
    };
    const orderCount = async () => {
        const { rows } = await pool.query(
            "SELECT COUNT(*)::int AS n FROM orders WHERE user_id=$1", [USER]);
        return rows[0].n;
    };

    const execute = () => paperExecutor({ userId: USER, mode: "INTRADAY" });

    describe("cash and position reconciliation", () => {
        it("a BUY debits cash and creates the position", async () => {
            const before = await cash();
            await execute()({ side: "BUY", symbol: "RELIANCE", quantity: 10,
                              clientOrderId: "recon-buy-1", correlationId: "c-1" });
            const position = await holding("RELIANCE");
            expect(position.quantity).toBe(10);
            expect(await cash()).toBeLessThan(before);
            expect(await orderCount()).toBe(1);
        });

        it("a SELL credits cash and reduces the position", async () => {
            await execute()({ side: "BUY", symbol: "TCS", quantity: 10,
                              clientOrderId: "recon-buy-2", correlationId: "c-2" });
            const afterBuy = await cash();
            await execute()({ side: "SELL", symbol: "TCS", quantity: 4,
                              clientOrderId: "recon-sell-1", correlationId: "c-2" });
            expect((await holding("TCS")).quantity).toBe(6);
            expect(await cash()).toBeGreaterThan(afterBuy);
        });

        it("selling the whole position removes it", async () => {
            await execute()({ side: "BUY", symbol: "INFY", quantity: 5,
                              clientOrderId: "recon-buy-3", correlationId: "c-3" });
            await execute()({ side: "SELL", symbol: "INFY", quantity: 5,
                              clientOrderId: "recon-sell-2", correlationId: "c-3" });
            expect(await holding("INFY")).toBeNull();
        });

        it("conserves cash across a round trip minus costs", async () => {
            const before = await cash();
            await execute()({ side: "BUY", symbol: "WIPRO", quantity: 10,
                              clientOrderId: "rt-buy", correlationId: "c-4" });
            await execute()({ side: "SELL", symbol: "WIPRO", quantity: 10,
                              clientOrderId: "rt-sell", correlationId: "c-4" });
            const after = await cash();
            // Costs must be charged: a round trip cannot be free or profitable.
            expect(after).toBeLessThan(before);
            expect(await holding("WIPRO")).toBeNull();
        });
    });

    describe("idempotency", () => {
        it("a repeated clientOrderId places no second order", async () => {
            const intent = { side: "BUY", symbol: "SBIN", quantity: 5,
                             clientOrderId: "dupe-1", correlationId: "c-5" };
            const first = await execute()(intent);
            const second = await execute()(intent);
            expect(first.duplicate).toBe(false);
            expect(second.duplicate).toBe(true);
            expect(await orderCount()).toBe(1);
            expect((await holding("SBIN")).quantity).toBe(5);
        });

        it("refuses to fill a symbol with no cached price", async () => {
            await redis.del("stock:ITC");
            await expect(execute()({ side: "BUY", symbol: "ITC", quantity: 1,
                                     clientOrderId: "no-price-1", correlationId: "c-np" }))
                .rejects.toThrow(/[Pp]rice/);
            expect(await orderCount()).toBe(0);
        });

        it("refuses an intent with no clientOrderId rather than risking a repeat", async () => {
            await expect(execute()({ side: "BUY", symbol: "ITC", quantity: 1 }))
                .rejects.toThrow(/clientOrderId/);
            expect(await orderCount()).toBe(0);
        });

        it("links the order to its correlation id for tracing", async () => {
            await execute()({ side: "BUY", symbol: "HDFCBANK", quantity: 2,
                              clientOrderId: "trace-1", correlationId: "corr-trace" });
            const { rows } = await pool.query(
                "SELECT correlation_id FROM orders WHERE client_order_id='trace-1'");
            expect(rows[0].correlation_id).toBe("corr-trace");
            expect(await orderForClientId("trace-1")).not.toBeNull();
        });
    });

    // These used to drive runLoopCycle, a second reasoning loop in loop.js that
    // nothing ran. It has been removed, and every guarantee it asserted is now
    // asserted against the path that is actually wired: the orchestrator's
    // reasoningCycle, through the real risk gate and the real paper engine.
    describe("the decision path end to end, through the real engine", () => {
        const AT = new Date("2026-08-31T05:00:00Z");   // 10:30 IST, a Monday

        const position = (over = {}) => ({
            symbol: "RELIANCE", userId: USER, side: "BUY", quantity: 10,
            entryPricePaise: 100000, currentPricePaise: 94000, exposurePaise: 940000,
            stale: false, dataAgeMs: 1000, sessionPhase: "MID_SESSION",
            thesisId: "t-1", correlationId: "loop-c-1", holdingSeconds: 3600,
            stopPaise: 95000, targetPaise: 110000,
            stopDistance: -0.2, targetDistance: 1.6, pnlPercent: -6,
            unrealisedPnlPaise: -60000, hasThesis: true, ...over,
        });

        const portfolio = (over = {}) => ({
            userId: USER, cashPaise: START_CASH, positionCount: 1,
            grossExposurePaise: 940_000, netExposurePaise: 940_000,
            unrealisedPnlPaise: -60_000,
            positions: [{ symbol: "RELIANCE", quantity: 10, exposurePaise: 940_000 }],
            ...over,
        });

        const thesisRow = {
            id: "t-1", side: "BUY", entry_price_paise: 100000,
            rationale: "breakout", setup_type: "breakout",
            invalidation_conditions: ["close below 990"], supporting_evidence: [],
            horizon: "INTRADAY", stop_paise: 95000, target_paise: 110000,
        };

        const buildOrchestrator = ({ decision, held = position(), book = portfolio(),
                                     recordReassessment = vi.fn(async () => ({})) }) => {
            const orchestrator = new Orchestrator({
                clock: () => AT,
                ports: {
                    loadPositions: async () => [held],
                    loadPortfolio: async () => book,
                    positionFor: async () => held,
                    loadThesis: async () => thesisRow,
                    // The real reassessment guardrails, with only the model injected.
                    reassess: async ({ position: p, thesis, event }) => reassessPosition({
                        position: p, thesis, event, portfolio: book,
                        callModel: async () => decision,
                    }),
                    intentFrom,
                    currentWorld: async () => ({
                        nowMs: AT.getTime(), pricePaise: held.currentPricePaise,
                        priceAgeMs: 1000, position: { quantity: held.quantity } }),
                    // The real risk gate.
                    evaluateRisk: async (intent) => evaluateRisk(intent, {
                        portfolio: book, nowMs: AT.getTime(), stale: false,
                        session: { trades: 0, turnoverPaise: 0, realisedLossPaise: 0 },
                        openClientOrderIds: [],
                    }),
                    // The real paper engine.
                    execute: execute(),
                    recordEvent: vi.fn(async () => ({ id: 1 })),
                    markEventHandled: vi.fn(async () => null),
                    markEventFailed: vi.fn(async () => null),
                    recordReassessment,
                    journal: vi.fn(async () => ({})),
                },
            });
            return { orchestrator, recordReassessment };
        };

        const offer = (orchestrator, over = {}) => orchestrator.queue.offer({
            ...makeEvent({
                type: "STOP_BREACH", symbol: "RELIANCE", severity: "CRITICAL",
                thesisId: "t-1", correlationId: "loop-c-1", source: "test",
                observed: {}, reason: "breached", observedAt: AT, bucket: "b", ...over }),
            storedId: 1,
        }, AT.getTime());

        it("EXIT flows through risk to a real paper order and closes the position", async () => {
            await execute()({ side: "BUY", symbol: "RELIANCE", quantity: 10,
                              clientOrderId: "seed-exit", correlationId: "loop-c-1" });
            expect((await holding("RELIANCE")).quantity).toBe(10);

            const { orchestrator, recordReassessment } = buildOrchestrator({
                decision: {
                    action: "EXIT", confidence: "HIGH", thesisStillValid: false,
                    whatChanged: "invalidation hit", material: true,
                    reasoning: "closed below the recorded level", evidence: [],
                },
            });
            offer(orchestrator);

            const [handled] = await orchestrator.reasoningCycle();
            expect(handled.action).toBe("EXIT");
            expect(handled.executed).toBe(true);
            expect(await holding("RELIANCE")).toBeNull();
            expect(recordReassessment).toHaveBeenCalledWith(
                expect.objectContaining({ executed: true, riskDecision: DECISION.ALLOW }));
        });

        it("REDUCE sells half and leaves the rest", async () => {
            await execute()({ side: "BUY", symbol: "RELIANCE", quantity: 10,
                              clientOrderId: "seed-reduce", correlationId: "loop-c-2" });

            const { orchestrator } = buildOrchestrator({
                decision: {
                    action: "REDUCE", confidence: "MEDIUM", thesisStillValid: true,
                    whatChanged: "momentum faded", material: true,
                    reasoning: "trim risk", evidence: [],
                },
            });
            offer(orchestrator);
            await orchestrator.reasoningCycle();

            expect((await holding("RELIANCE")).quantity).toBe(5);
        });

        it("places NO order when risk rejects", async () => {
            await execute()({ side: "BUY", symbol: "RELIANCE", quantity: 10,
                              clientOrderId: "seed-reject", correlationId: "loop-c-3" });
            const ordersBefore = await orderCount();

            const { orchestrator } = buildOrchestrator({
                decision: {
                    action: "ADD", confidence: "HIGH", thesisStillValid: true,
                    whatChanged: "momentum", material: true, reasoning: "add", evidence: [],
                },
                held: position({ quantity: 600 }),
                book: portfolio({ cashPaise: 1000 }),
            });
            offer(orchestrator);

            const [handled] = await orchestrator.reasoningCycle();
            expect(handled.executed).toBe(false);
            expect(handled.risk).toBeDefined();
            expect(orchestrator.metrics.riskRejections).toBe(1);
            expect(await orderCount()).toBe(ordersBefore);
            expect((await holding("RELIANCE")).quantity).toBe(10);
        });

        it("HOLD creates no order at all", async () => {
            await execute()({ side: "BUY", symbol: "RELIANCE", quantity: 10,
                              clientOrderId: "seed-hold", correlationId: "loop-c-4" });
            const ordersBefore = await orderCount();

            const { orchestrator } = buildOrchestrator({
                decision: {
                    action: "HOLD", confidence: "HIGH", thesisStillValid: true,
                    whatChanged: "nothing material", material: false,
                    reasoning: "structure intact", evidence: [],
                },
            });
            offer(orchestrator);

            const [handled] = await orchestrator.reasoningCycle();
            expect(handled.action).toBe("HOLD");
            expect(handled.executed).toBe(false);
            expect(await orderCount()).toBe(ordersBefore);
        });

        it("a malformed AI response executes nothing", async () => {
            await execute()({ side: "BUY", symbol: "RELIANCE", quantity: 10,
                              clientOrderId: "seed-malformed", correlationId: "loop-c-5" });
            const ordersBefore = await orderCount();

            const { orchestrator } = buildOrchestrator({
                decision: { action: "LIQUIDATE EVERYTHING" },
            });
            offer(orchestrator);

            const [handled] = await orchestrator.reasoningCycle();
            expect(handled.action).toBe("HOLD");
            expect(await orderCount()).toBe(ordersBefore);
            expect((await holding("RELIANCE")).quantity).toBe(10);
        });

        it("running the same decision twice produces one order, not two", async () => {
            await execute()({ side: "BUY", symbol: "RELIANCE", quantity: 10,
                              clientOrderId: "seed-idem", correlationId: "loop-c-6" });

            const decision = {
                action: "REDUCE", confidence: "HIGH", thesisStillValid: true,
                whatChanged: "x", material: true, reasoning: "y", evidence: [],
            };
            const first = buildOrchestrator({ decision });
            offer(first.orchestrator);
            await first.orchestrator.reasoningCycle();
            const afterFirst = await orderCount();

            // A second orchestrator over the same state: a restart mid-session.
            // The intent key is derived from the thesis and the action, so the
            // engine absorbs the repeat instead of placing a second order.
            const second = buildOrchestrator({
                decision, held: position({ quantity: 5 }) });
            offer(second.orchestrator);
            await second.orchestrator.reasoningCycle();

            expect(await orderCount()).toBe(afterFirst);
        });
    });
});
