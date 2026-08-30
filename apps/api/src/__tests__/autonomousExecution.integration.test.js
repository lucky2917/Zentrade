import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// Reconciliation for the full chain: AI decision -> risk gate -> intent ->
// paper order -> position -> cash -> journal. Uses the real tradingEngine and
// a real Postgres; only the model is injected.

describe.skipIf(!TEST_DB || !TEST_REDIS)("autonomous execution reconciliation", () => {
    let pool, redis, paperExecutor, orderForClientId, runLoopCycle, DECISION;
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
        ({ runLoopCycle } = await import("../services/autonomous/loop.js"));
        ({ DECISION } = await import("../services/autonomous/riskGate.js"));

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

    describe("the loop end to end, through the real engine", () => {
        const position = (over = {}) => ({
            symbol: "RELIANCE", userId: USER, side: "BUY", quantity: 10,
            entryPricePaise: 100000, currentPricePaise: 94000, exposurePaise: 940000,
            stale: false, dataAgeMs: 1000, sessionPhase: "MID_SESSION",
            thesisId: "t-1", correlationId: "loop-c-1", holdingSeconds: 3600,
            stopPaise: 95000, targetPaise: 110000,
            stopDistance: -0.2, targetDistance: 1.6, pnlPercent: -6,
            unrealisedPnlPaise: -60000, hasThesis: true, ...over,
        });

        const portfolio = () => ({
            userId: USER, cashPaise: START_CASH, positionCount: 1,
            grossExposurePaise: 940_000, netExposurePaise: 940_000, unrealisedPnlPaise: -60_000,
            positions: [{ symbol: "RELIANCE", quantity: 10, exposurePaise: 940_000 }],
        });

        const basePorts = (over = {}) => ({
            recordEvent: vi.fn(async (e) => ({ id: `ev-${e.type}` })),
            loadThesis: vi.fn(async () => ({
                id: "t-1", side: "BUY", entry_price_paise: 100000,
                rationale: "breakout", setup_type: "breakout",
                invalidation_conditions: ["close below 990"], supporting_evidence: [],
                horizon: "INTRADAY", stop_paise: 95000, target_paise: 110000,
            })),
            recordReassessment: vi.fn(async () => ({})),
            journal: vi.fn(async () => ({})),
            ...over,
        });

        it("EXIT flows through risk to a real paper order and closes the position", async () => {
            await execute()({ side: "BUY", symbol: "RELIANCE", quantity: 10,
                              clientOrderId: "seed-exit", correlationId: "loop-c-1" });
            expect((await holding("RELIANCE")).quantity).toBe(10);

            const ports = basePorts({
                callModel: async () => ({
                    action: "EXIT", confidence: "HIGH", thesisStillValid: false,
                    whatChanged: "invalidation hit", material: true,
                    reasoning: "closed below the recorded level", evidence: [],
                }),
                execute: execute(),
            });

            const cycle = await runLoopCycle({
                positions: [position()], portfolio: portfolio(),
                riskContext: { session: { trades: 0, turnoverPaise: 0, realisedLossPaise: 0 } },
                now: new Date("2026-08-31T05:00:00Z"), ports,
            });

            expect(cycle.decisions[0].action).toBe("EXIT");
            expect(cycle.decisions[0].risk).toBe(DECISION.ALLOW);
            expect(cycle.executions).toBe(1);
            expect(await holding("RELIANCE")).toBeNull();
            expect(ports.recordReassessment).toHaveBeenCalledWith(
                expect.objectContaining({ executed: true, riskDecision: DECISION.ALLOW }));
        });

        it("REDUCE sells half and leaves the rest", async () => {
            await execute()({ side: "BUY", symbol: "RELIANCE", quantity: 10,
                              clientOrderId: "seed-reduce", correlationId: "loop-c-2" });

            const ports = basePorts({
                callModel: async () => ({
                    action: "REDUCE", confidence: "MEDIUM", thesisStillValid: true,
                    whatChanged: "momentum faded", material: true,
                    reasoning: "trim risk", evidence: [],
                }),
                execute: execute(),
            });

            await runLoopCycle({
                positions: [position({ correlationId: "loop-c-2" })], portfolio: portfolio(),
                riskContext: { session: { trades: 0, turnoverPaise: 0, realisedLossPaise: 0 } },
                now: new Date("2026-08-31T05:00:00Z"), ports,
            });

            expect((await holding("RELIANCE")).quantity).toBe(5);
        });

        it("places NO order when risk rejects", async () => {
            await execute()({ side: "BUY", symbol: "RELIANCE", quantity: 10,
                              clientOrderId: "seed-reject", correlationId: "loop-c-3" });
            const ordersBefore = await orderCount();

            const ports = basePorts({
                callModel: async () => ({
                    action: "ADD", confidence: "HIGH", thesisStillValid: true,
                    whatChanged: "momentum", material: true, reasoning: "add", evidence: [],
                }),
                execute: execute(),
            });

            const cycle = await runLoopCycle({
                positions: [position({ correlationId: "loop-c-3", quantity: 600 })],
                portfolio: { ...portfolio(), cashPaise: 1000 },
                riskContext: { session: { trades: 0, turnoverPaise: 0, realisedLossPaise: 0 } },
                now: new Date("2026-08-31T05:00:00Z"), ports,
            });

            expect(cycle.riskRejections).toBe(1);
            expect(cycle.executions).toBe(0);
            expect(await orderCount()).toBe(ordersBefore);
            expect((await holding("RELIANCE")).quantity).toBe(10);
        });

        it("HOLD creates no order at all", async () => {
            await execute()({ side: "BUY", symbol: "RELIANCE", quantity: 10,
                              clientOrderId: "seed-hold", correlationId: "loop-c-4" });
            const ordersBefore = await orderCount();

            const ports = basePorts({
                callModel: async () => ({
                    action: "HOLD", confidence: "HIGH", thesisStillValid: true,
                    whatChanged: "nothing material", material: false,
                    reasoning: "structure intact", evidence: [],
                }),
                execute: execute(),
            });

            const cycle = await runLoopCycle({
                positions: [position({ correlationId: "loop-c-4" })], portfolio: portfolio(),
                riskContext: { session: { trades: 0, turnoverPaise: 0, realisedLossPaise: 0 } },
                now: new Date("2026-08-31T05:00:00Z"), ports,
            });

            expect(cycle.intents).toBe(0);
            expect(await orderCount()).toBe(ordersBefore);
        });

        it("a malformed AI response executes nothing", async () => {
            await execute()({ side: "BUY", symbol: "RELIANCE", quantity: 10,
                              clientOrderId: "seed-malformed", correlationId: "loop-c-5" });
            const ordersBefore = await orderCount();

            const ports = basePorts({
                callModel: async () => ({ action: "LIQUIDATE EVERYTHING" }),
                execute: execute(),
            });

            const cycle = await runLoopCycle({
                positions: [position({ correlationId: "loop-c-5" })], portfolio: portfolio(),
                riskContext: { session: { trades: 0, turnoverPaise: 0, realisedLossPaise: 0 } },
                now: new Date("2026-08-31T05:00:00Z"), ports,
            });

            expect(cycle.decisions[0].action).toBe("HOLD");
            expect(await orderCount()).toBe(ordersBefore);
            expect((await holding("RELIANCE")).quantity).toBe(10);
        });

        it("running the same cycle twice produces one order, not two", async () => {
            await execute()({ side: "BUY", symbol: "RELIANCE", quantity: 10,
                              clientOrderId: "seed-idem", correlationId: "loop-c-6" });

            const ports = basePorts({
                callModel: async () => ({
                    action: "REDUCE", confidence: "HIGH", thesisStillValid: true,
                    whatChanged: "x", material: true, reasoning: "y", evidence: [],
                }),
                execute: execute(),
            });
            const input = () => ({
                positions: [position({ correlationId: "loop-c-6" })], portfolio: portfolio(),
                riskContext: { session: { trades: 0, turnoverPaise: 0, realisedLossPaise: 0 } },
                now: new Date("2026-08-31T05:00:00Z"), ports,
            });

            await runLoopCycle(input());
            const afterFirst = await orderCount();
            await runLoopCycle(input());
            expect(await orderCount()).toBe(afterFirst);
        });
    });
});
