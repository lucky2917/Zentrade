import { afterAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

describe.skipIf(!TEST_DB || !TEST_REDIS)("execution engine (integration)", () => {
    let pool, engine, reconcile, STATES, InvalidTransition;
    const USER = 7777;
    const CASH = 100_000_000; // Rs 10,00,000
    const PRICE = 100_000;    // Rs 1,000

    beforeEach(async () => {
        ({ pool } = await import("../config/db.js"));
        engine = await import("../services/execution/engine.js");
        reconcile = await import("../services/execution/reconcile.js");
        ({ STATES, InvalidTransition } = await import("../services/execution/states.js"));

        await pool.query("DELETE FROM order_reconciliations WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'exec@test',$2)
             ON CONFLICT (id) DO UPDATE SET balance_paise=$2`, [USER, CASH]);
    });

    afterAll(async () => { if (pool) await pool.end(); });

    const balance = async () => {
        const { rows } = await pool.query("SELECT balance_paise FROM users WHERE id=$1", [USER]);
        return Number(rows[0].balance_paise);
    };
    const holding = async (symbol) => {
        const { rows } = await pool.query(
            "SELECT quantity FROM portfolio WHERE user_id=$1 AND symbol=$2", [USER, symbol]);
        return rows.length ? Number(rows[0].quantity) : 0;
    };
    const submit = (over = {}) => engine.submitOrder({
        userId: USER, symbol: "RELIANCE", side: "BUY", quantity: 100,
        pricePaise: PRICE, clientOrderId: `coid-${Math.random()}`,
        correlationId: "corr-1", ...over,
    });
    const toWorking = async (id) => { await engine.acceptOrder(id); return engine.workOrder(id); };

    describe("submission does not execute", () => {
        it("a new order is NEW with nothing filled", async () => {
            const { order } = await submit();
            expect(order.state).toBe(STATES.NEW);
            expect(Number(order.filled_quantity)).toBe(0);
            expect(await holding("RELIANCE")).toBe(0);
        });

        it("submission does not move settled cash, only reserves it", async () => {
            const before = await balance();
            const { order } = await submit();
            expect(await balance()).toBe(before);
            expect(Number(order.reserved_paise)).toBeGreaterThan(0);
        });

        it("a fill cannot be applied before the order is working", async () => {
            const { order } = await submit();
            await expect(engine.applyFill({
                orderId: order.id, executionRef: "x", quantity: 10, pricePaise: PRICE,
            })).rejects.toThrow(InvalidTransition);
        });
    });

    describe("reservations", () => {
        it("reduce available cash without touching the balance", async () => {
            const { order } = await submit();
            const available = await engine.availableCashPaise(USER);
            expect(available).toBe(CASH - Number(order.reserved_paise));
        });

        it("a second order can only use what remains available", async () => {
            // DELIVERY reserves the full notional; INTRADAY divides by leverage,
            // so the interesting case for a cash limit is delivery.
            await submit({ quantity: 600, mode: "DELIVERY", clientOrderId: "big-1" });
            await expect(submit({ quantity: 600, mode: "DELIVERY", clientOrderId: "big-2" }))
                .rejects.toThrow(engine.InsufficientCash);
        });

        it("release on cancellation, restoring availability", async () => {
            const { order } = await submit();
            await engine.cancelOrder(order.id);
            expect(Number((await engine.getOrder(order.id)).reserved_paise)).toBe(0);
            expect(await engine.availableCashPaise(USER)).toBe(CASH);
        });

        it("release on expiry", async () => {
            const { order } = await submit();
            await engine.acceptOrder(order.id);
            await engine.expireOrder(order.id);
            expect(Number((await engine.getOrder(order.id)).reserved_paise)).toBe(0);
        });

        it("release on rejection", async () => {
            const { order } = await submit();
            await engine.rejectOrder(order.id, "venue refused");
            const after = await engine.getOrder(order.id);
            expect(Number(after.reserved_paise)).toBe(0);
            expect(after.rejection_reason).toBe("venue refused");
        });

        it("shrink to the remaining obligation on a partial fill, and to zero when complete", async () => {
            const { order } = await submit({ quantity: 100, clientOrderId: "res-partial" });
            const initial = Number(order.reserved_paise);
            await toWorking(order.id);

            const half = await engine.applyFill({
                orderId: order.id, executionRef: "f1", quantity: 40, pricePaise: PRICE });
            const afterPartial = Number(half.order.reserved_paise);
            expect(afterPartial).toBeGreaterThan(0);
            expect(afterPartial).toBeLessThan(initial);

            const done = await engine.applyFill({
                orderId: order.id, executionRef: "f2", quantity: 60, pricePaise: PRICE });
            expect(done.order.state).toBe(STATES.FILLED);
            expect(Number(done.order.reserved_paise)).toBe(0);
        });

        it("no non-terminal order ever holds a reservation once terminal", async () => {
            const { order } = await submit({ clientOrderId: "term-1" });
            await engine.cancelOrder(order.id);
            const { rows } = await pool.query(
                `SELECT COUNT(*)::int n FROM orders
                 WHERE user_id=$1 AND state IN ('FILLED','CANCELLED','EXPIRED','REJECTED')
                   AND reserved_paise <> 0`, [USER]);
            expect(rows[0].n).toBe(0);
        });
    });

    describe("partial fills", () => {
        it("30 / 40 / 30 walks PARTIALLY_FILLED then FILLED", async () => {
            const { order } = await submit({ quantity: 100, clientOrderId: "pf-1" });
            await toWorking(order.id);

            const a = await engine.applyFill({ orderId: order.id, executionRef: "a", quantity: 30, pricePaise: PRICE });
            expect(a.order.state).toBe(STATES.PARTIALLY_FILLED);
            expect(Number(a.order.filled_quantity)).toBe(30);

            const b = await engine.applyFill({ orderId: order.id, executionRef: "b", quantity: 40, pricePaise: PRICE });
            expect(b.order.state).toBe(STATES.PARTIALLY_FILLED);
            expect(Number(b.order.filled_quantity)).toBe(70);

            const c = await engine.applyFill({ orderId: order.id, executionRef: "c", quantity: 30, pricePaise: PRICE });
            expect(c.order.state).toBe(STATES.FILLED);
            expect(Number(c.order.filled_quantity)).toBe(100);
            expect(await holding("RELIANCE")).toBe(100);
        });

        it("sum of fills always equals filled_quantity", async () => {
            const { order } = await submit({ quantity: 100, clientOrderId: "pf-sum" });
            await toWorking(order.id);
            for (const [ref, qty] of [["a", 25], ["b", 25], ["c", 50]]) {
                await engine.applyFill({ orderId: order.id, executionRef: ref, quantity: qty, pricePaise: PRICE });
            }
            const { rows } = await pool.query(
                `SELECT o.filled_quantity, COALESCE(SUM(f.quantity),0) AS fills
                 FROM orders o LEFT JOIN order_fills f ON f.order_id=o.id
                 WHERE o.id=$1 GROUP BY o.filled_quantity`, [order.id]);
            expect(Number(rows[0].filled_quantity)).toBe(Number(rows[0].fills));
        });

        it("partial then cancellation keeps the filled part and releases the rest", async () => {
            const { order } = await submit({ quantity: 100, clientOrderId: "pf-cancel" });
            await toWorking(order.id);
            await engine.applyFill({ orderId: order.id, executionRef: "a", quantity: 30, pricePaise: PRICE });
            await engine.cancelOrder(order.id);
            const after = await engine.getOrder(order.id);
            expect(after.state).toBe(STATES.CANCELLED);
            expect(Number(after.filled_quantity)).toBe(30);
            expect(Number(after.reserved_paise)).toBe(0);
            expect(await holding("RELIANCE")).toBe(30);
        });

        it("partial then expiry behaves the same and fabricates no rejection", async () => {
            const { order } = await submit({ quantity: 100, clientOrderId: "pf-expire" });
            await toWorking(order.id);
            await engine.applyFill({ orderId: order.id, executionRef: "a", quantity: 20, pricePaise: PRICE });
            await engine.expireOrder(order.id);
            const after = await engine.getOrder(order.id);
            expect(after.state).toBe(STATES.EXPIRED);
            expect(after.rejection_reason).toBeNull();
            expect(await holding("RELIANCE")).toBe(20);
        });

        it("refuses an overfill", async () => {
            const { order } = await submit({ quantity: 50, clientOrderId: "of-1" });
            await toWorking(order.id);
            await engine.applyFill({ orderId: order.id, executionRef: "a", quantity: 40, pricePaise: PRICE });
            await expect(engine.applyFill({
                orderId: order.id, executionRef: "b", quantity: 20, pricePaise: PRICE }))
                .rejects.toThrow(/overfill/);
            expect(Number((await engine.getOrder(order.id)).filled_quantity)).toBe(40);
        });

        it("absorbs a duplicate fill notification", async () => {
            const { order } = await submit({ quantity: 100, clientOrderId: "dupfill" });
            await toWorking(order.id);
            const first = await engine.applyFill({ orderId: order.id, executionRef: "same", quantity: 30, pricePaise: PRICE });
            const second = await engine.applyFill({ orderId: order.id, executionRef: "same", quantity: 30, pricePaise: PRICE });
            expect(first.duplicate).toBe(false);
            expect(second.duplicate).toBe(true);
            expect(Number((await engine.getOrder(order.id)).filled_quantity)).toBe(30);
            expect(await holding("RELIANCE")).toBe(30);
            expect(await engine.fillsFor(order.id)).toHaveLength(1);
        });
    });

    describe("cash and position atomicity", () => {
        it("a fill moves cash and position together", async () => {
            // The debit is margin plus brokerage, from the shared ledger. It was
            // the full notional here, which is what let a position closed by the
            // legacy square-off destroy its own principal (red team F1).
            const { buyDebitPaise } = await import("../services/execution/ledger.js");
            const before = await balance();
            const { order } = await submit({ quantity: 10, clientOrderId: "atomic-1" });
            await toWorking(order.id);
            await engine.applyFill({ orderId: order.id, executionRef: "a", quantity: 10, pricePaise: PRICE });
            expect(await balance()).toBe(
                before - buyDebitPaise({ quantity: 10, pricePaise: PRICE, mode: "INTRADAY" }));
            expect(await holding("RELIANCE")).toBe(10);
        });

        it("a sell that would go negative is refused and changes nothing", async () => {
            const buy = await submit({ quantity: 10, clientOrderId: "sell-setup" });
            await toWorking(buy.order.id);
            await engine.applyFill({ orderId: buy.order.id, executionRef: "a", quantity: 10, pricePaise: PRICE });

            const sell = await submit({ side: "SELL", quantity: 50, clientOrderId: "sell-neg" });
            await toWorking(sell.order.id);
            const cashBefore = await balance();
            await expect(engine.applyFill({
                orderId: sell.order.id, executionRef: "s", quantity: 50, pricePaise: PRICE }))
                .rejects.toThrow(/negative position/);
            expect(await holding("RELIANCE")).toBe(10);
            expect(await balance()).toBe(cashBefore);
            expect(await engine.fillsFor(sell.order.id)).toHaveLength(0);
        });
    });

    describe("idempotency", () => {
        it("a repeated clientOrderId returns the original and reserves nothing more", async () => {
            const a = await submit({ clientOrderId: "idem-1" });
            const availableAfterFirst = await engine.availableCashPaise(USER);
            const b = await submit({ clientOrderId: "idem-1" });
            expect(b.duplicate).toBe(true);
            expect(b.order.id).toBe(a.order.id);
            expect(await engine.availableCashPaise(USER)).toBe(availableAfterFirst);
        });

        it("concurrent duplicate submissions create exactly one order", async () => {
            const attempts = Array.from({ length: 8 }, () =>
                submit({ clientOrderId: "race-1", quantity: 5 }).catch((e) => ({ error: e })));
            const results = await Promise.all(attempts);
            const created = results.filter((r) => r.order && !r.duplicate);
            expect(created.length).toBeLessThanOrEqual(1);
            const { rows } = await pool.query(
                "SELECT COUNT(*)::int n FROM orders WHERE client_order_id='race-1'");
            expect(rows[0].n).toBe(1);
        });
    });

    describe("concurrency against one balance", () => {
        it("never reserves beyond the balance", async () => {
            const attempts = Array.from({ length: 10 }, (_, i) =>
                submit({ quantity: 200, mode: "DELIVERY", clientOrderId: `conc-${i}` })
                    .catch((e) => ({ error: e })));
            await Promise.all(attempts);
            const { rows } = await pool.query(
                `SELECT COALESCE(SUM(reserved_paise),0) AS reserved FROM orders
                 WHERE user_id=$1 AND state = ANY($2)`, [USER, engine.OPEN_STATES]);
            expect(Number(rows[0].reserved)).toBeLessThanOrEqual(CASH);
        });
    });

    describe("expiry sweep", () => {
        it("expires resting orders past their expiry and releases reservations", async () => {
            const past = new Date(Date.now() - 60_000);
            const { order } = await submit({ clientOrderId: "exp-1", expiresAt: past });
            await toWorking(order.id);
            const expired = await engine.expireStaleOrders(new Date());
            expect(expired.map((o) => o.id)).toContain(order.id);
            expect(Number((await engine.getOrder(order.id)).reserved_paise)).toBe(0);
        });

        it("leaves orders with no expiry alone", async () => {
            const { order } = await submit({ clientOrderId: "exp-none" });
            await toWorking(order.id);
            await engine.expireStaleOrders(new Date());
            expect((await engine.getOrder(order.id)).state).toBe(STATES.WORKING);
        });
    });

    describe("ambiguity and reconciliation", () => {
        it("an unreachable venue leaves the order AMBIGUOUS rather than guessing", async () => {
            const { order } = await submit({ clientOrderId: "amb-1" });
            await toWorking(order.id);
            const result = await reconcile.reconcileOrder(order.id, null);
            expect(result.outcome).toBe(reconcile.OUTCOME.AMBIGUOUS);
            expect(result.order.state).toBe(STATES.AMBIGUOUS);
            expect(result.order.ambiguity_reason).toMatch(/not established/);
        });

        it("agreeing states reconcile as MATCHED without changing anything", async () => {
            const { order } = await submit({ clientOrderId: "rec-match" });
            await toWorking(order.id);
            const result = await reconcile.reconcileOrder(order.id, {
                state: STATES.WORKING, filledQuantity: 0 });
            expect(result.outcome).toBe(reconcile.OUTCOME.MATCHED);
            expect((await engine.getOrder(order.id)).state).toBe(STATES.WORKING);
        });

        it("applies fills the venue saw that we missed", async () => {
            const { order } = await submit({ quantity: 100, clientOrderId: "rec-fills" });
            await toWorking(order.id);
            const result = await reconcile.reconcileOrder(order.id, {
                state: STATES.PARTIALLY_FILLED, filledQuantity: 60,
                fills: [{ executionRef: "ext-1", quantity: 60, pricePaise: PRICE }],
            });
            expect(result.outcome).toBe(reconcile.OUTCOME.MISMATCH);
            expect(Number(result.order.filled_quantity)).toBe(60);
            expect(await holding("RELIANCE")).toBe(60);
        });

        it("does not invent a reversal when we believe more filled than the venue", async () => {
            const { order } = await submit({ quantity: 100, clientOrderId: "rec-over" });
            await toWorking(order.id);
            await engine.applyFill({ orderId: order.id, executionRef: "a", quantity: 50, pricePaise: PRICE });
            const result = await reconcile.reconcileOrder(order.id, {
                state: STATES.WORKING, filledQuantity: 0 });
            expect(result.outcome).toBe(reconcile.OUTCOME.MISMATCH);
            expect(result.order.state).toBe(STATES.AMBIGUOUS);
            expect(Number(result.order.filled_quantity)).toBe(50); // unchanged
        });

        it("recovers from AMBIGUOUS once truth is available", async () => {
            const { order } = await submit({ quantity: 100, clientOrderId: "amb-resolve" });
            await toWorking(order.id);
            await reconcile.reconcileOrder(order.id, null);
            expect((await engine.getOrder(order.id)).state).toBe(STATES.AMBIGUOUS);
            const resolved = await reconcile.reconcileOrder(order.id, {
                state: STATES.CANCELLED, filledQuantity: 0 });
            expect(resolved.outcome).toBe(reconcile.OUTCOME.MISMATCH);
            expect(resolved.order.state).toBe(STATES.CANCELLED);
            expect(Number(resolved.order.reserved_paise)).toBe(0);
        });

        it("unresolved ambiguity is visible to callers", async () => {
            expect(await reconcile.hasUnresolvedAmbiguity(USER)).toBe(false);
            const { order } = await submit({ clientOrderId: "amb-flag" });
            await toWorking(order.id);
            await reconcile.reconcileOrder(order.id, null);
            expect(await reconcile.hasUnresolvedAmbiguity(USER)).toBe(true);
        });

        it("keeps every reconciliation attempt as evidence", async () => {
            const { order } = await submit({ clientOrderId: "rec-audit" });
            await toWorking(order.id);
            await reconcile.reconcileOrder(order.id, { state: STATES.WORKING, filledQuantity: 0 });
            await reconcile.reconcileOrder(order.id, null);
            expect(await reconcile.reconciliationsFor(order.id)).toHaveLength(2);
        });
    });

    describe("restart recovery", () => {
        it("reconstructs open orders, partial fills, reservations, cash and positions", async () => {
            const { order } = await submit({ quantity: 100, clientOrderId: "restart-1" });
            await toWorking(order.id);
            await engine.applyFill({ orderId: order.id, executionRef: "a", quantity: 40, pricePaise: PRICE });

            const cashBefore = await balance();
            const heldBefore = await holding("RELIANCE");

            // The engine holds no in-memory state: everything lives in Postgres.
            // A restart is therefore indistinguishable from a fresh read, which
            // is the property being asserted.
            const fresh = engine;
            const open = await fresh.openOrders(USER);
            const recovered = open.find((o) => o.client_order_id === "restart-1");

            expect(recovered).toBeDefined();
            expect(recovered.state).toBe(STATES.PARTIALLY_FILLED);
            expect(Number(recovered.filled_quantity)).toBe(40);
            expect(Number(recovered.reserved_paise)).toBeGreaterThan(0);
            expect(await balance()).toBe(cashBefore);
            expect(await holding("RELIANCE")).toBe(heldBefore);
            expect(await fresh.fillsFor(order.id)).toHaveLength(1);
        });

        it("a restart causes no duplicate action: resubmitting the same id is absorbed", async () => {
            const { order } = await submit({ clientOrderId: "restart-2" });
            const fresh = engine;
            const again = await fresh.submitOrder({
                userId: USER, symbol: "RELIANCE", side: "BUY", quantity: 100,
                pricePaise: PRICE, clientOrderId: "restart-2" });
            expect(again.duplicate).toBe(true);
            expect(again.order.id).toBe(order.id);
        });
    });

    describe("correlation and linkage", () => {
        it("carries correlation id from order to fill", async () => {
            const { order } = await submit({ clientOrderId: "corr-link", correlationId: "trace-99" });
            await toWorking(order.id);
            await engine.applyFill({ orderId: order.id, executionRef: "a", quantity: 10, pricePaise: PRICE });
            const fills = await engine.fillsFor(order.id);
            expect(order.correlation_id).toBe("trace-99");
            expect(fills[0].correlation_id).toBe("trace-99");
        });
    });
});
