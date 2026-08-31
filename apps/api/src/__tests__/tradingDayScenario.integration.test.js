import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// Two trading days, three processes, one account.
//
// The pieces are covered individually elsewhere. What this asserts is that they
// agree with each other: that the money the ledger moved is the money the
// account reports, that a position survives the process that opened it, and
// that the second day starts from the first day's result rather than from the
// opening capital.

describe.skipIf(!TEST_DB || !TEST_REDIS)("two trading days across three restarts", () => {
    let pool, redis, engine, account, session, PaperVenue;
    const USER = 8495;
    const START = 100_000_000;                 // Rs 10,00,000
    const A = "TCS";
    const B = "INFY";

    const DAY1 = "2026-09-01";                 // a Tuesday
    const DAY2 = "2026-09-02";
    const at = (day, h, m) => new Date(`${day}T${String(h - 5).padStart(2, "0")}:${
        String(m + 30).padStart(2, "0")}:00.000Z`);   // IST h:m as UTC

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        ({ default: redis } = await import("../config/redis.js"));
        engine = await import("../services/execution/engine.js");
        account = await import("../services/account/paperAccount.js");
        session = await import("../services/account/session.js");
        ({ PaperVenue } = await import("../services/execution/paperVenue.js"));
    });

    beforeEach(async () => {
        for (const table of ["agent_events", "session_summaries", "decision_records",
                             "paper_account", "position_events"]) {
            await pool.query(`DELETE FROM ${table} WHERE user_id=$1`, [USER]);
        }
        await pool.query(
            "DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)",
            [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM trade_thesis WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'scenario@test',$2)
             ON CONFLICT (id) DO UPDATE SET balance_paise=$2`, [USER, START]);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const marks = new Map();
    const priceFor = async (symbol) => marks.get(symbol) ?? null;

    // One process. Everything it knows it read back from the database.
    const boot = async (clockAt) => {
        const venue = new PaperVenue({ engine, clock: () => clockAt });
        const adopted = await venue.adopt(await engine.openOrders(USER));
        const acct = await session.openAccountSession({
            userId: USER, priceFor, clock: () => clockAt,
            intervalMs: 3_600_000, pid: 1 });
        return { venue, adopted, acct };
    };

    const buy = async (venue, { symbol, quantity, pricePaise, ref }) => {
        const result = await venue.submit({
            userId: USER, symbol, side: "BUY", quantity, pricePaise,
            mode: "INTRADAY", clientOrderId: ref, correlationId: ref });
        const { rows } = await pool.query(
            `INSERT INTO trade_thesis (user_id, symbol, correlation_id, side,
                entry_price_paise, quantity, rationale, setup_type,
                invalidation_conditions, supporting_evidence, stop_paise,
                target_paise, horizon)
             VALUES ($1,$2,$3,'BUY',$4,$5,$6,'breakout',$7::jsonb,$8::jsonb,$9,$10,'INTRADAY')
             RETURNING id`,
            [USER, symbol, ref, pricePaise, quantity,
             `bought ${symbol} on a breakout`, JSON.stringify(["closes back under the level"]),
             JSON.stringify([{ tier: "FACT", statement: "volume confirmed" }]),
             Math.round(pricePaise * 0.98), Math.round(pricePaise * 1.04)]);
        return { order: result.order, thesisId: rows[0].id };
    };

    const sell = async (venue, { symbol, quantity, pricePaise, ref, thesisId }) => {
        const result = await venue.submit({
            userId: USER, symbol, side: "SELL", quantity, pricePaise,
            mode: "INTRADAY", clientOrderId: ref, correlationId: ref, thesisId });
        await pool.query(
            "UPDATE trade_thesis SET closed_at=NOW() WHERE id=$1", [thesisId]);
        return result.order;
    };

    const cash = async () => Number((await pool.query(
        "SELECT balance_paise FROM users WHERE id=$1", [USER])).rows[0].balance_paise);

    it("runs two days over three processes and stays internally consistent",
       async () => {
        // ---- Day 1, morning. The account is opened for the first time. -----
        const morning = await boot(at(DAY1, 9, 20));
        expect(morning.acct.account.opened).toBe(true);
        expect(morning.acct.opening.cashPaise).toBe(START);
        expect(morning.acct.opening.startingCapitalPaise).toBe(START);
        expect(morning.acct.reconciliation.ok).toBe(true);

        // Two symbols. One will be closed the same day, one held overnight.
        const bought = await buy(morning.venue,
            { symbol: A, quantity: 100, pricePaise: 300_000, ref: "d1-a-buy" });
        const heldOvernight = await buy(morning.venue,
            { symbol: B, quantity: 200, pricePaise: 150_000, ref: "d1-b-buy" });
        expect(bought.order.state).toBe("FILLED");

        // A winner is taken. The engine books the P&L on the order, which is
        // the only durable place it exists once the position is gone.
        await sell(morning.venue, { symbol: A, quantity: 100, pricePaise: 309_000,
                                    ref: "d1-a-sell", thesisId: bought.thesisId });
        const closed = await pool.query(
            "SELECT pnl_paise FROM orders WHERE user_id=$1 AND client_order_id='d1-a-sell'",
            [USER]);
        expect(Number(closed.rows[0].pnl_paise)).toBe(900_000);   // Rs 9,000

        marks.set(B, 152_000);
        const endOfDay1 = await morning.acct.state();
        expect(endOfDay1.realisedPnlPaise).toBe(900_000);
        expect(endOfDay1.unrealisedPnlPaise).toBe(400_000);       // 200 x Rs 20
        expect(endOfDay1.positions).toHaveLength(1);
        expect(endOfDay1.equityPaise).toBe(
            START + 900_000 + 400_000 - endOfDay1.costsPaise);

        // Orders are stamped by the database clock; a test that spans days has
        // to put them where it claims they happened before summarising the day.
        await pool.query(
            `UPDATE orders SET created_at = $2::timestamptz, completed_at = $2::timestamptz
             WHERE user_id = $1`, [USER, at(DAY1, 12, 0)]);
        await account.writeSessionSummary({
            userId: USER, state: endOfDay1, at: at(DAY1, 15, 25) });
        await morning.acct.close("end of day");
        const day1Close = await cash();

        // ---- Day 1, evening. A crash and an immediate restart. -------------
        const restarted = await boot(at(DAY1, 15, 28));
        expect(restarted.acct.account.opened).toBe(false);
        expect(restarted.acct.opening.cashPaise).toBe(day1Close);
        expect(restarted.acct.opening.startingCapitalPaise).toBe(START);
        expect(restarted.acct.reconciliation.ok).toBe(true);
        // The overnight position came back with its own entry, not a default.
        const [recovered] = restarted.acct.opening.positions;
        expect(recovered.symbol).toBe(B);
        expect(recovered.quantity).toBe(200);
        expect(recovered.avgPricePaise).toBe(150_000);
        // And its thesis is still the one that justified it.
        const thesis = await pool.query(
            `SELECT id, stop_paise, target_paise, rationale FROM trade_thesis
             WHERE user_id=$1 AND closed_at IS NULL`, [USER]);
        expect(thesis.rows).toHaveLength(1);
        expect(thesis.rows[0].id).toBe(heldOvernight.thesisId);
        expect(Number(thesis.rows[0].stop_paise)).toBe(147_000);
        expect(thesis.rows[0].rationale).toContain("breakout");
        await restarted.acct.close("shutdown");

        // ---- Day 2. A new process on a new day. ---------------------------
        const nextDay = await boot(at(DAY2, 9, 20));
        // The number this whole design exists for.
        expect(nextDay.acct.opening.cashPaise).toBe(day1Close);
        expect(nextDay.acct.opening.cashPaise).not.toBe(START);
        expect(nextDay.acct.opening.startingCapitalPaise).toBe(START);
        expect(nextDay.acct.opening.realisedPnlPaise).toBe(900_000);

        // The overnight position is closed into a loss on day two.
        marks.set(B, 148_000);
        await sell(nextDay.venue, { symbol: B, quantity: 200, pricePaise: 148_000,
                                    ref: "d2-b-sell", thesisId: heldOvernight.thesisId });

        await pool.query(
            `UPDATE orders SET created_at = $2::timestamptz, completed_at = $2::timestamptz
             WHERE user_id = $1 AND client_order_id = 'd2-b-sell'`, [USER, at(DAY2, 12, 0)]);

        const final = await nextDay.acct.state();
        expect(final.positions).toHaveLength(0);
        // Rs 9,000 made on day one, Rs 4,000 lost on day two.
        expect(final.realisedPnlPaise).toBe(900_000 - 400_000);
        expect(final.unrealisedPnlPaise).toBe(0);
        expect(final.equityPaise).toBe(await cash());
        expect(final.totalPnlPaise).toBe(500_000 - final.costsPaise);

        await account.writeSessionSummary({
            userId: USER, state: final, at: at(DAY2, 15, 25) });

        // ---- what the two days say about each other -----------------------
        const summaries = await pool.query(
            `SELECT session_date, opening_cash_paise, closing_cash_paise, realised_pnl_paise
             FROM session_summaries WHERE user_id=$1 ORDER BY session_date`, [USER]);
        expect(summaries.rows).toHaveLength(2);
        const [d1, d2] = summaries.rows;
        expect(Number(d2.opening_cash_paise)).toBe(Number(d1.closing_cash_paise));
        expect(Number(d1.realised_pnl_paise)).toBe(900_000);
        expect(Number(d2.realised_pnl_paise)).toBe(-400_000);

        // Three starts and two clean stops are on the record.
        const events = await pool.query(
            "SELECT kind FROM agent_events WHERE user_id=$1 ORDER BY id", [USER]);
        expect(events.rows.map((r) => r.kind)).toEqual([
            "AGENT_START", "AGENT_STOP", "AGENT_START", "AGENT_STOP", "AGENT_START"]);

        // And the ledger still agrees with itself after all of it.
        const reconciled = await account.reconcileAccount({ userId: USER });
        expect(reconciled.ok).toBe(true);
        expect(reconciled.driftPaise).toBe(0);

        marks.clear();
    });

    it("a restart never places the same order twice", async () => {
        const first = await boot(at(DAY1, 9, 20));
        await buy(first.venue, { symbol: A, quantity: 100, pricePaise: 300_000,
                                 ref: "dup-buy" });
        const afterFirst = await cash();

        // The next process re-derives the same intent and submits it again.
        const second = await boot(at(DAY1, 9, 25));
        const repeat = await second.venue.submit({
            userId: USER, symbol: A, side: "BUY", quantity: 100, pricePaise: 300_000,
            mode: "INTRADAY", clientOrderId: "dup-buy", correlationId: "dup-buy" });

        expect(repeat.duplicate).toBe(true);
        expect(await cash()).toBe(afterFirst);
        const orders = await pool.query(
            "SELECT COUNT(*)::int n FROM orders WHERE user_id=$1", [USER]);
        expect(orders.rows[0].n).toBe(1);
        expect((await account.reconcileAccount({ userId: USER })).ok).toBe(true);
    });

    it("a process that died holding a resting order does not strand the cash",
       async () => {
        // A venue that acknowledges and rests. The process goes away.
        const dying = new PaperVenue({ engine, defaultBehaviour: "DELAYED_FILL" });
        await session.openAccountSession({
            userId: USER, priceFor, clock: () => at(DAY1, 9, 20),
            intervalMs: 3_600_000, pid: 1 });
        await dying.submit({
            userId: USER, symbol: A, side: "BUY", quantity: 100, pricePaise: 300_000,
            mode: "INTRADAY", clientOrderId: "rest-1", correlationId: "rest-1" });
        await pool.query(
            `INSERT INTO trade_thesis (user_id, symbol, correlation_id, side,
                entry_price_paise, quantity, rationale, setup_type,
                invalidation_conditions, supporting_evidence, horizon)
             VALUES ($1,$2,'rest-1','BUY',300000,100,'resting entry','breakout',
                     '["closes back under"]'::jsonb,'[]'::jsonb,'INTRADAY')`,
            [USER, A]);
        expect(await engine.openOrders(USER)).toHaveLength(1);

        const next = await boot(at(DAY1, 9, 25));
        expect(next.adopted).toBe(1);
        await next.venue.tick();

        expect(await engine.openOrders(USER)).toHaveLength(0);
        // The margin is committed to a position now, not held against an order
        // that would never have completed.
        const state = await next.acct.state();
        expect(state.positions).toHaveLength(1);
        expect((await account.reconcileAccount({ userId: USER })).ok).toBe(true);
    });
});
