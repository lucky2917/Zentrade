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
    let pool, redis, engine, PaperVenue;
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
    });

    beforeEach(async () => {
        await pool.query(
            "DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)",
            [USER]);
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
