import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// An order that was resting when the process died.
//
// PaperVenue tracks resting orders in memory. A restart built a new venue with
// an empty map, so an ACCEPTED or WORKING order in the database was never
// advanced again: it could not fill, could not expire (the runtime sets no
// expiry), and reconciliation compared it against the venue's view of the same
// database row and reported MATCHED. It rested forever holding its cash
// reservation, which permanently reduced available cash.

describe.skipIf(!TEST_DB || !TEST_REDIS)("a restart adopts resting orders", () => {
    let pool, redis, engine, PaperVenue, reconcile;
    const USER = 8492;
    const SYMBOL = "INFY";
    const START = 100_000_000;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        ({ default: redis } = await import("../config/redis.js"));
        engine = await import("../services/execution/engine.js");
        ({ PaperVenue } = await import("../services/execution/paperVenue.js"));
        reconcile = await import("../services/execution/reconcile.js");
    });

    beforeEach(async () => {
        await pool.query(
            "DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)",
            [USER]);
        await pool.query(
            `DELETE FROM order_reconciliations WHERE order_id IN
             (SELECT id FROM orders WHERE user_id=$1)`, [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'venue@test',$2)
             ON CONFLICT (id) DO UPDATE SET balance_paise=$2`, [USER, START]);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const intent = (over = {}) => ({
        userId: USER, symbol: SYMBOL, side: "BUY", quantity: 100,
        pricePaise: 150_000, mode: "INTRADAY",
        clientOrderId: "venue-1", correlationId: "venue-1", ...over,
    });

    const available = () => engine.availableCashPaise(USER);

    it("fills an order left WORKING by the previous process", async () => {
        // A venue that acknowledges but does not fill: the order is resting
        // when the process goes away.
        const before = new PaperVenue({ engine, defaultBehaviour: "DELAYED_FILL" });
        const { order } = await before.submit(intent());
        expect(order.state).toBe("WORKING");
        const reservedWhileResting = await available();
        expect(reservedWhileResting).toBeLessThan(START);

        // The process restarts. A brand new venue, no memory of anything.
        const after = new PaperVenue({ engine });
        expect(after.health().resting).toBe(0);

        const adopted = await after.adopt(await engine.openOrders(USER));
        expect(adopted).toBe(1);

        await after.tick();
        const settled = await engine.getOrder(order.id);
        expect(settled.state).toBe("FILLED");
        expect(Number(settled.filled_quantity)).toBe(100);
        // The reservation is released because the order reached a terminal state.
        expect(Number(settled.reserved_paise)).toBe(0);
    });

    it("drives an order that was never acknowledged", async () => {
        const before = new PaperVenue({ engine, defaultBehaviour: "SILENT" });
        const { order } = await before.submit(intent({ clientOrderId: "venue-2",
                                                       correlationId: "venue-2" }));
        expect(order.state).toBe("NEW");

        const after = new PaperVenue({ engine });
        await after.adopt(await engine.openOrders(USER));
        await after.tick();

        expect((await engine.getOrder(order.id)).state).toBe("FILLED");
    });

    it("leaves an AMBIGUOUS order for reconciliation rather than filling it",
       async () => {
        const before = new PaperVenue({ engine, defaultBehaviour: "DELAYED_FILL" });
        const { order } = await before.submit(intent({ clientOrderId: "venue-3",
                                                       correlationId: "venue-3" }));
        await engine.markAmbiguous(order.id, "venue went silent");

        const after = new PaperVenue({ engine });
        expect(await after.adopt(await engine.openOrders(USER))).toBe(0);
        await after.tick();

        // Untouched. Its outcome is unknown, and inventing one is the failure
        // AMBIGUOUS exists to prevent.
        expect((await engine.getOrder(order.id)).state).toBe("AMBIGUOUS");
    });

    // The deadlock. externalStateOf used to read the order's own row back and
    // present it as external truth, so an AMBIGUOUS order was compared against
    // itself, reconciliation recorded MATCHED and "states agree", and it could
    // never leave the state. Live, a TCS BUY sat AMBIGUOUS for hours holding
    // Rs 99,982 of reserved cash — and because unresolved ambiguity blocks new
    // exposure, one stuck order halted the entire book.
    it("resolves an ambiguous order the venue never worked", async () => {
        const before = new PaperVenue({ engine, defaultBehaviour: "DELAYED_FILL" });
        const { order } = await before.submit(intent({ clientOrderId: "amb-1",
                                                       correlationId: "amb-1" }));
        await engine.markAmbiguous(order.id, "venue went silent");

        // A new process: the venue has no memory of it, and no fill exists.
        const after = new PaperVenue({ engine });
        const external = await after.externalStateOf(await engine.getOrder(order.id));
        expect(external).toEqual({ state: "CANCELLED", filledQuantity: 0, fills: [] });

        const { outcome } = await reconcile.reconcileOrder(order.id, external);
        expect(outcome).toBe("MISMATCH");
        const resolved = await engine.getOrder(order.id);
        expect(resolved.state).toBe("CANCELLED");
        // And the cash it was holding is released.
        expect(Number(resolved.reserved_paise)).toBe(0);
        expect(await reconcile.hasUnresolvedAmbiguity(USER)).toBe(false);
    });

    it("reports what actually filled when the venue lost a part-filled order",
       async () => {
        const before = new PaperVenue({ engine, defaultBehaviour: "DELAYED_FILL" });
        const { order } = await before.submit(intent({ clientOrderId: "amb-2",
                                                       correlationId: "amb-2" }));
        await engine.applyFill({ orderId: order.id, executionRef: "p1",
                                 quantity: 40, pricePaise: 150_000 });
        await engine.markAmbiguous(order.id, "process died mid-flight");

        const after = new PaperVenue({ engine });
        const external = await after.externalStateOf(await engine.getOrder(order.id));
        // 40 of 100: the fills are the record, and they say partially filled.
        expect(external).toMatchObject({ state: "PARTIALLY_FILLED", filledQuantity: 40 });
    });

    it("never invents an outcome for an order the venue is still holding", async () => {
        const venue = new PaperVenue({ engine, defaultBehaviour: "SILENT" });
        const { order } = await venue.submit(intent({ clientOrderId: "amb-3",
                                                      correlationId: "amb-3" }));
        // A venue that has not answered must produce AMBIGUOUS, not a guess.
        expect(await venue.externalStateOf(order)).toBeNull();
    });

    it("does not adopt an order it is already driving", async () => {
        const venue = new PaperVenue({ engine, defaultBehaviour: "DELAYED_FILL" });
        await venue.submit(intent({ clientOrderId: "venue-4", correlationId: "venue-4" }));
        expect(venue.health().resting).toBe(1);
        expect(await venue.adopt(await engine.openOrders(USER))).toBe(0);
        expect(venue.health().resting).toBe(1);
    });

    it("releases the cash a restart would otherwise have stranded", async () => {
        const before = new PaperVenue({ engine, defaultBehaviour: "DELAYED_FILL" });
        await before.submit(intent({ clientOrderId: "venue-5", correlationId: "venue-5" }));

        const stranded = await available();
        const after = new PaperVenue({ engine });
        await after.adopt(await engine.openOrders(USER));
        await after.tick();

        // The margin is committed to the position now, not held against an
        // order that will never complete.
        expect(await available()).toBeGreaterThan(stranded);
        expect(await engine.openOrders(USER)).toHaveLength(0);
    });
});
