import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// One continuous paper account across days and restarts.
//
// The failure this guards against is the obvious one: a process that starts in
// the morning and quietly begins again at Rs 10,00,000, discarding yesterday's
// result and the positions still open. Every assertion below is about
// continuity — the same account, the same starting reference, the same cash,
// the same positions, the same reasoning record, after the process is gone.

describe.skipIf(!TEST_DB || !TEST_REDIS)("persistent paper account", () => {
    let pool, redis, engine, account, session;
    const USER = 8491;
    const SYMBOL = "TCS";
    const START = 100_000_000;          // Rs 10,00,000

    const DAY1 = "2026-08-24";
    const DAY2 = "2026-08-25";
    const DAY3 = "2026-08-26";
    // 09:20 and 15:20 IST, as UTC instants.
    const open = (d) => new Date(`${d}T03:50:00.000Z`);
    const close = (d) => new Date(`${d}T09:50:00.000Z`);

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        ({ default: redis } = await import("../config/redis.js"));
        engine = await import("../services/execution/engine.js");
        account = await import("../services/account/paperAccount.js");
        session = await import("../services/account/session.js");
    });

    beforeEach(async () => {
        await pool.query("DELETE FROM agent_events WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM session_summaries WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM decision_records WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM paper_account WHERE user_id=$1", [USER]);
        await pool.query(
            "DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)",
            [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM trade_thesis WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'persistent@test',$2)
             ON CONFLICT (id) DO UPDATE SET balance_paise=$2`, [USER, START]);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    // A price source under the test's control. accountState takes it as an
    // argument precisely so valuation is not a hidden read.
    const marks = new Map();
    const priceFor = async (symbol) => marks.get(symbol) ?? null;

    const cash = async () => Number((await pool.query(
        "SELECT balance_paise FROM users WHERE id=$1", [USER])).rows[0].balance_paise);

    const fill = async ({ side, quantity, pricePaise, ref }) => {
        const { order } = await engine.submitOrder({
            userId: USER, symbol: SYMBOL, side, quantity, pricePaise, mode: "INTRADAY",
            clientOrderId: `acct-${ref}`, correlationId: `acct-${ref}` });
        await engine.acceptOrder(order.id);
        await engine.workOrder(order.id);
        await engine.applyFill({ orderId: order.id, executionRef: ref, quantity, pricePaise });
        return order;
    };

    // Orders are stamped by the database clock, so a test that spans days has
    // to move them there. Nothing in the account code reads this; it exists so
    // the per-day counts in the summary are about the day they claim to be.
    const backdateOrders = async (day) => {
        await pool.query(
            `UPDATE orders SET created_at = $2::timestamptz, completed_at = $2::timestamptz
             WHERE user_id = $1 AND created_at > $2::timestamptz`, [USER, close(day)]);
    };

    const openThesis = async (correlationId, { quantity, entryPricePaise }) => {
        const { rows } = await pool.query(
            `INSERT INTO trade_thesis (user_id, symbol, correlation_id, side,
                entry_price_paise, quantity, rationale, setup_type,
                invalidation_conditions, supporting_evidence, stop_paise,
                target_paise, horizon)
             VALUES ($1,$2,$3,'BUY',$4,$5,$6,'test setup',$7::jsonb,$8::jsonb,
                     $9,$10,'INTRADAY')
             RETURNING id`,
            [USER, SYMBOL, correlationId, entryPricePaise, quantity,
             "bought because the test said so", JSON.stringify(["close below stop"]),
             JSON.stringify([{ tier: "FACT", statement: "test" }]),
             entryPricePaise - 2000, entryPricePaise + 4000]);
        return rows[0].id;
    };

    // A restart is a fresh call to the same lifecycle with no memory of the
    // last one. Everything it knows, it read back from the database.
    const restart = async (at) => session.openAccountSession({
        userId: USER, priceFor, clock: () => at, intervalMs: 3_600_000, pid: 1234 });

    describe("opening", () => {
        it("opens once at Rs 10,00,000 and never re-opens", async () => {
            const first = await account.ensureAccount({ userId: USER });
            expect(first.opened).toBe(true);
            expect(Number(first.starting_capital_paise)).toBe(START);

            // A different starting capital offered later must be ignored: the
            // reference every P&L figure is measured against cannot move.
            const second = await account.ensureAccount({
                userId: USER, startingCapitalPaise: 500_000_000 });
            expect(second.opened).toBe(false);
            expect(Number(second.starting_capital_paise)).toBe(START);
        });

        it("opens over an existing balance without inventing or losing money",
           async () => {
            // History from before the account record existed: cash moved, but
            // no order carries the P&L that moved it.
            await pool.query("UPDATE users SET balance_paise = $2 WHERE id=$1",
                             [USER, START - 89_700]);
            const opened = await account.ensureAccount({ userId: USER });
            expect(Number(opened.opening_adjustment_paise)).toBe(-89_700);

            // The identity holds from the first moment, so any later drift is a
            // real fault rather than inherited noise.
            const result = await account.reconcileAccount({ userId: USER });
            expect(result.ok).toBe(true);
            expect(result.driftPaise).toBe(0);

            const state = await account.accountState({ userId: USER, priceFor });
            expect(state.startingCapitalPaise).toBe(START);
            expect(state.realisedPnlPaise).toBe(-89_700);
            expect(state.openingAdjustmentPaise).toBe(-89_700);
            expect(state.totalPnlPaise).toBe(-89_700);
        });

        it("measures the opening adjustment once and never again", async () => {
            await account.ensureAccount({ userId: USER });
            await pool.query("UPDATE users SET balance_paise = balance_paise - 12_000 WHERE id=$1",
                             [USER]);
            const again = await account.ensureAccount({ userId: USER });
            expect(Number(again.opening_adjustment_paise)).toBe(0);
            // The loss is now visible as drift, which is the point of it.
            expect((await account.reconcileAccount({ userId: USER })).driftPaise).toBe(-12_000);
        });

        it("reports cash, equity and P&L against the starting capital", async () => {
            await account.ensureAccount({ userId: USER });
            const state = await account.accountState({ userId: USER, priceFor });
            expect(state.startingCapitalPaise).toBe(START);
            expect(state.cashPaise).toBe(START);
            expect(state.equityPaise).toBe(START);
            expect(state.realisedPnlPaise).toBe(0);
            expect(state.openingAdjustmentPaise).toBe(0);
            expect(state.unrealisedPnlPaise).toBe(0);
            expect(state.totalPnlPaise).toBe(0);
            expect(state.mode).toBe("PAPER");
        });
    });

    describe("across a restart", () => {
        it("continues from the cash it left, not from the starting capital", async () => {
            const s1 = await restart(open(DAY1));
            expect(s1.opening.cashPaise).toBe(START);

            await fill({ side: "BUY", quantity: 100, pricePaise: 300_000, ref: "d1-buy" });
            await openThesis("acct-d1-buy", { quantity: 100, entryPricePaise: 300_000 });
            const afterTrading = await cash();
            expect(afterTrading).toBeLessThan(START);
            await s1.close("test");

            const s2 = await restart(close(DAY1));
            expect(s2.account.opened).toBe(false);
            expect(Number(s2.account.starting_capital_paise)).toBe(START);
            expect(s2.opening.cashPaise).toBe(afterTrading);
        });

        it("recovers the open position with its entry, thesis, stop and target",
           async () => {
            await restart(open(DAY1));
            await fill({ side: "BUY", quantity: 100, pricePaise: 300_000, ref: "d1-buy" });
            const thesisId = await openThesis("acct-d1-buy",
                                              { quantity: 100, entryPricePaise: 300_000 });

            marks.set(SYMBOL, 305_000);
            const s2 = await restart(open(DAY2));
            expect(s2.opening.positions).toHaveLength(1);
            const [held] = s2.opening.positions;
            expect(held.symbol).toBe(SYMBOL);
            expect(held.quantity).toBe(100);
            expect(held.avgPricePaise).toBe(300_000);
            expect(held.unrealisedPnlPaise).toBe(500_000);
            expect(s2.opening.unrealisedPnlPaise).toBe(500_000);

            const { rows } = await pool.query(
                `SELECT id, stop_paise, target_paise, rationale FROM trade_thesis
                 WHERE user_id=$1 AND symbol=$2 AND closed_at IS NULL`, [USER, SYMBOL]);
            expect(rows).toHaveLength(1);
            expect(rows[0].id).toBe(thesisId);
            expect(Number(rows[0].stop_paise)).toBe(298_000);
            expect(Number(rows[0].target_paise)).toBe(304_000);
            marks.delete(SYMBOL);
        });

        it("records that it started, what it resumed from, and that it stopped",
           async () => {
            const s1 = await restart(open(DAY1));
            await s1.close("SIGTERM");
            await restart(open(DAY2));

            const { rows } = await pool.query(
                `SELECT kind, detail, session_date FROM agent_events
                 WHERE user_id=$1 ORDER BY id ASC`, [USER]);
            expect(rows.map((r) => r.kind))
                .toEqual(["AGENT_START", "AGENT_STOP", "AGENT_START"]);
            expect(rows[0].detail.openedAccount).toBe(true);
            expect(rows[0].detail.cashPaise).toBe(START);
            expect(rows[1].detail.reason).toBe("SIGTERM");
            // The second start opened nothing: it resumed.
            expect(rows[2].detail.openedAccount).toBe(false);
            expect(String(rows[2].session_date)).toContain("2026");
        });
    });

    describe("across trading days", () => {
        it("carries the closing cash of one day into the opening of the next",
           async () => {
            // Day 1: buy and hold overnight.
            const d1 = await restart(open(DAY1));
            await fill({ side: "BUY", quantity: 100, pricePaise: 300_000, ref: "d1-buy" });
            await openThesis("acct-d1-buy", { quantity: 100, entryPricePaise: 300_000 });
            await backdateOrders(DAY1);
            await account.writeSessionSummary({
                userId: USER, state: await d1.state(), at: close(DAY1) });
            const day1Close = await cash();

            // Day 2: a fresh process. Sell into a higher price.
            const d2 = await restart(open(DAY2));
            expect(d2.opening.cashPaise).toBe(day1Close);
            await fill({ side: "SELL", quantity: 100, pricePaise: 310_000, ref: "d2-sell" });
            await pool.query(
                "UPDATE trade_thesis SET closed_at = NOW() WHERE user_id=$1 AND symbol=$2",
                [USER, SYMBOL]);
            await backdateOrders(DAY2);
            await account.writeSessionSummary({
                userId: USER, state: await d2.state(), at: close(DAY2) });

            const { rows } = await pool.query(
                `SELECT session_date, opening_cash_paise, closing_cash_paise,
                        realised_pnl_paise
                 FROM session_summaries WHERE user_id=$1 ORDER BY session_date`, [USER]);
            expect(rows).toHaveLength(2);
            const [day1, day2] = rows;

            expect(Number(day1.opening_cash_paise)).toBe(START);
            expect(Number(day1.closing_cash_paise)).toBe(day1Close);
            // The number the whole feature exists for.
            expect(Number(day2.opening_cash_paise)).toBe(Number(day1.closing_cash_paise));
            expect(Number(day2.opening_cash_paise)).not.toBe(START);

            // 100 shares bought at 3000.00 and sold at 3100.00.
            expect(Number(day2.realised_pnl_paise)).toBe(1_000_000);

            const final = await account.accountState({ userId: USER, priceFor });
            expect(final.realisedPnlPaise).toBe(1_000_000);
            expect(final.positions).toHaveLength(0);
            // Two orders' brokerage is the only cost between capital and equity.
            expect(final.equityPaise)
                .toBe(START + 1_000_000 - final.costsPaise);
            expect(final.totalPnlPaise).toBe(1_000_000 - final.costsPaise);
        });

        it("keeps the opening figure of a day even when the day is written again",
           async () => {
            const d1 = await restart(open(DAY1));
            await account.writeSessionSummary({
                userId: USER, state: await d1.state(), at: open(DAY1) });
            await fill({ side: "BUY", quantity: 50, pricePaise: 300_000, ref: "d1-buy" });
            await openThesis("acct-d1-buy", { quantity: 50, entryPricePaise: 300_000 });
            await account.writeSessionSummary({
                userId: USER, state: await d1.state(), at: close(DAY1) });

            const { rows } = await pool.query(
                `SELECT opening_cash_paise, closing_cash_paise FROM session_summaries
                 WHERE user_id=$1 AND session_date=$2`, [USER, DAY1]);
            expect(rows).toHaveLength(1);
            expect(Number(rows[0].opening_cash_paise)).toBe(START);
            expect(Number(rows[0].closing_cash_paise)).toBe(await cash());
        });

        it("survives three days and two restarts without resetting", async () => {
            const days = [DAY1, DAY2, DAY3];
            let previousClose = START;
            for (const [i, day] of days.entries()) {
                const s = await restart(open(day));
                expect(s.opening.cashPaise).toBe(previousClose);
                expect(s.opening.startingCapitalPaise).toBe(START);

                await fill({ side: "BUY", quantity: 10, pricePaise: 300_000,
                             ref: `d${i}-buy` });
                await openThesis(`acct-d${i}-buy`,
                                 { quantity: 10, entryPricePaise: 300_000 });
                await fill({ side: "SELL", quantity: 10, pricePaise: 302_000,
                             ref: `d${i}-sell` });
                await pool.query(
                    "UPDATE trade_thesis SET closed_at=NOW() WHERE user_id=$1 AND symbol=$2",
                    [USER, SYMBOL]);
                await backdateOrders(day);
                await account.writeSessionSummary({
                    userId: USER, state: await s.state(), at: close(day) });
                await s.close("end of day");
                previousClose = await cash();
            }

            const { rows } = await pool.query(
                `SELECT session_date, opening_cash_paise, closing_cash_paise
                 FROM session_summaries WHERE user_id=$1 ORDER BY session_date`, [USER]);
            expect(rows).toHaveLength(3);
            for (let i = 1; i < rows.length; i += 1) {
                expect(Number(rows[i].opening_cash_paise))
                    .toBe(Number(rows[i - 1].closing_cash_paise));
            }
            const state = await account.accountState({ userId: USER, priceFor });
            expect(state.startingCapitalPaise).toBe(START);
            expect(state.realisedPnlPaise).toBe(3 * 20_000);
        });
    });

    describe("the decision record", () => {
        const decision = (correlationId, over = {}) => ({
            correlationId, sessionDate: DAY1, symbol: SYMBOL, route: "CANDIDATE",
            triggerType: "screen", triggerReason: "volume spike",
            action: "HOLD", confidence: "MEDIUM",
            evidence: [{ tier: "FACT", source: "tick", statement: "price 3000.00" }],
            thesis: "Extended above VWAP with no confirmation.",
            supporting: ["above VWAP"], contradicting: ["thin volume"],
            counterThesis: "The move is a single print, not participation.",
            alternatives: ["mean reversion"],
            whatWouldChange: ["a second push on real volume"],
            challengeVerdict: "THESIS_WEAK",
            synthesis: { riskReward: { ratio: 0.9 }, setupType: "vwap extension" },
            riskDecision: "ALLOW", executed: false,
            blockedReason: "risk/reward below the entry floor",
            decidedAt: open(DAY1), ...over,
        });

        it("stores every decision, including the ones that never traded", async () => {
            await account.recordDecision({ userId: USER, record: decision("cand-1") });
            await account.recordDecision({
                userId: USER, record: decision("cand-2", { action: "BUY", executed: true,
                                                           quantity: 100, pricePaise: 300_000 }) });

            const rows = await account.recentDecisions({ userId: USER });
            expect(rows).toHaveLength(2);
            const rejected = rows.find((r) => r.correlation_id === "cand-1");
            expect(rejected.action).toBe("HOLD");
            expect(rejected.executed).toBe(false);
            expect(rejected.blocked_reason).toBe("risk/reward below the entry floor");
            expect(rejected.challenge_verdict).toBe("THESIS_WEAK");
            expect(rejected.counter_thesis).toContain("single print");
            expect(rejected.evidence[0].tier).toBe("FACT");
            expect(rejected.alternatives).toEqual(["mean reversion"]);
            expect(rejected.what_would_change).toEqual(["a second push on real volume"]);
            expect(rejected.synthesis.riskReward.ratio).toBe(0.9);
        });

        it("cannot record the same decision twice", async () => {
            await account.recordDecision({ userId: USER, record: decision("cand-1") });
            await account.recordDecision({ userId: USER, record: decision("cand-1") });
            const rows = await account.recentDecisions({ userId: USER });
            expect(rows).toHaveLength(1);
        });

        it("is still there after a restart, and is retrievable from the cockpit",
           async () => {
            await restart(open(DAY1));
            await account.recordDecision({ userId: USER, record: decision("cand-1") });
            await restart(open(DAY2));

            const { readDecisions } = await import("../services/cockpit/state.js");
            const decisions = await readDecisions(USER, { limit: 10 });
            expect(decisions).toHaveLength(1);
            expect(decisions[0].correlationId).toBe("cand-1");
            expect(decisions[0].thesis).toContain("VWAP");
            expect(decisions[0].trigger).toEqual({
                type: "screen", severity: null, reason: "volume spike" });
        });

        // The runtime does not call recordDecision. It calls the journal port,
        // and the port is where a decision stops being in memory.
        it("is written by the port the runtime actually calls", async () => {
            const { buildLivePorts } = await import("../services/autonomous/livePorts.js");
            const ports = buildLivePorts({
                userId: USER, newsStore: null, connectionTracker: null,
                clock: () => open(DAY1) });

            await ports.journal({
                correlationId: "cand-live-1", symbol: SYMBOL, route: "CANDIDATE",
                asOf: open(DAY1),
                event: { type: "VOLUME_SPIKE", severity: "INFO", reason: "3x baseline" },
                context: { price: 3000 },
                decision: {
                    action: "BUY", confidence: "MEDIUM", quantity: 100,
                    reasoning: "Breakout holding above VWAP on real participation.",
                    evidence: [{ tier: "FACT", source: "tick", statement: "3x volume" }],
                    supportingEvidence: ["volume confirms"],
                    contradictingEvidence: ["late in the session"],
                    alternativeHypotheses: ["single-print spike"],
                    whatWouldChangeMyMind: ["a close back under VWAP"],
                    challenge: { verdict: "THESIS_HOLDS", counterThesis: "one buyer, not many" },
                    riskReward: { ratio: 1.8 }, setupType: "vwap reclaim",
                    stopPaise: 298_000, targetPaise: 306_000, horizon: "INTRADAY",
                },
                risk: { decision: "ALLOW", code: null, reason: null },
                intent: { pricePaise: 300_000, quantity: 100 },
                executed: true,
            });

            const [row] = await account.recentDecisions({ userId: USER });
            expect(row.correlation_id).toBe("cand-live-1");
            expect(row.route).toBe("CANDIDATE");
            expect(row.action).toBe("BUY");
            expect(row.executed).toBe(true);
            expect(row.trigger_type).toBe("VOLUME_SPIKE");
            expect(row.trigger_reason).toBe("3x baseline");
            expect(row.thesis).toContain("VWAP");
            expect(row.contradicting).toEqual(["late in the session"]);
            expect(row.challenge_verdict).toBe("THESIS_HOLDS");
            expect(row.counter_thesis).toBe("one buyer, not many");
            expect(row.synthesis.riskReward.ratio).toBe(1.8);
            expect(Number(row.price_paise)).toBe(300_000);
            expect(Number(row.quantity)).toBe(100);
        });

        it("never fails a decision because the record could not be written",
           async () => {
            const { buildLivePorts } = await import("../services/autonomous/livePorts.js");
            const errors = [];
            const ports = buildLivePorts({
                userId: USER, newsStore: null, connectionTracker: null,
                logger: { info: () => {}, error: (...a) => errors.push(a) } });

            // A symbol far longer than the column allows. The decision has
            // already been taken; the write must not throw it away.
            const entry = { correlationId: "cand-bad", symbol: "X".repeat(200),
                            decision: { action: "HOLD" }, executed: false };
            await expect(ports.journal(entry)).resolves.toBe(entry);
            expect(errors).toHaveLength(1);
        });

        // Every reassessment of one position shares the thesis's correlation
        // id. Keying the record on that stored the first decision and silently
        // discarded every later one, which is most of a position's life.
        it("stores every decision on one position, not just the first",
           async () => {
            const { buildLivePorts } = await import("../services/autonomous/livePorts.js");
            const ports = buildLivePorts({
                userId: USER, newsStore: null, connectionTracker: null,
                clock: () => open(DAY1) });

            for (const [i, action] of ["HOLD", "HOLD", "EXIT"].entries()) {
                await ports.journal({
                    // One thesis, one correlation id, three decisions.
                    correlationId: "thesis-corr-1",
                    decisionId: `dec-${i}`,
                    symbol: SYMBOL, route: "POSITION", asOf: open(DAY1),
                    event: { type: "STOP_APPROACHING", severity: "WARNING" },
                    decision: { action, confidence: "MEDIUM",
                                reasoning: `pass ${i}`, evidence: [] },
                    risk: { decision: "ALLOW" },
                    executed: action === "EXIT",
                });
            }

            const rows = await account.recentDecisions({ userId: USER });
            expect(rows).toHaveLength(3);
            expect(rows.map((r) => r.action).sort()).toEqual(["EXIT", "HOLD", "HOLD"]);
            // The correlation is still what ties them to the position.
            expect(new Set(rows.map((r) => r.correlation_id))).toEqual(
                new Set(["thesis-corr-1"]));
        });

        it("still absorbs a genuine retry of the same decision", async () => {
            const { buildLivePorts } = await import("../services/autonomous/livePorts.js");
            const ports = buildLivePorts({
                userId: USER, newsStore: null, connectionTracker: null,
                clock: () => open(DAY1) });
            const entry = {
                correlationId: "thesis-corr-2", decisionId: "dec-same",
                symbol: SYMBOL, route: "POSITION", asOf: open(DAY1),
                decision: { action: "HOLD" }, executed: false,
            };
            await ports.journal(entry);
            await ports.journal(entry);
            expect(await account.recentDecisions({ userId: USER })).toHaveLength(1);
        });

        it("filters by symbol", async () => {
            await account.recordDecision({ userId: USER, record: decision("cand-1") });
            await account.recordDecision({
                userId: USER, record: decision("cand-2", { symbol: "INFY" }) });
            const rows = await account.recentDecisions({ userId: USER, symbol: "INFY" });
            expect(rows).toHaveLength(1);
            expect(rows[0].symbol).toBe("INFY");
        });
    });

    describe("partial fills", () => {
        // A partially filled order that then expires settled real cash and
        // booked real P&L. Counting only state='FILLED' left that money out of
        // realised P&L and costs, which showed up as reconciliation drift on an
        // account that was in fact correct.
        const fillPart = async ({ side, quantity, pricePaise, ref, of }) => {
            const { order } = await engine.submitOrder({
                userId: USER, symbol: SYMBOL, side, quantity: of, pricePaise,
                mode: "INTRADAY", clientOrderId: `part-${ref}`, correlationId: `part-${ref}` });
            await engine.acceptOrder(order.id);
            await engine.workOrder(order.id);
            await engine.applyFill({ orderId: order.id, executionRef: ref, quantity, pricePaise });
            return order;
        };

        it("counts the P&L and costs of an order that expired part-filled",
           async () => {
            await restart(open(DAY1));
            await fill({ side: "BUY", quantity: 100, pricePaise: 300_000, ref: "d1-buy" });
            await openThesis("acct-d1-buy", { quantity: 100, entryPricePaise: 300_000 });

            // Half the exit fills, then the rest of the order expires.
            const order = await fillPart({ side: "SELL", quantity: 50, of: 100,
                                           pricePaise: 310_000, ref: "d1-part" });
            await engine.expireOrder(order.id);

            const after = await pool.query(
                "SELECT state, filled_quantity, pnl_paise, brokerage_paise FROM orders WHERE id=$1",
                [order.id]);
            expect(after.rows[0].state).toBe("EXPIRED");
            expect(Number(after.rows[0].filled_quantity)).toBe(50);
            expect(Number(after.rows[0].pnl_paise)).toBe(500_000);

            const state = await account.accountState({ userId: USER, priceFor });
            expect(state.realisedPnlPaise).toBe(500_000);
            expect(state.costsPaise).toBe(4_000);

            // And the identity still holds, because the same money is on both
            // sides of it.
            const result = await account.reconcileAccount({ userId: USER });
            expect(result.driftPaise).toBe(0);
            expect(result.ok).toBe(true);
        });

        it("ignores an order that never filled at all", async () => {
            await restart(open(DAY1));
            const { order } = await engine.submitOrder({
                userId: USER, symbol: SYMBOL, side: "BUY", quantity: 10,
                pricePaise: 300_000, mode: "INTRADAY",
                clientOrderId: "never-filled", correlationId: "never-filled" });
            await engine.acceptOrder(order.id);
            await engine.cancelOrder(order.id);

            const state = await account.accountState({ userId: USER, priceFor });
            // Brokerage is written on the row at submission but no cash moved.
            expect(state.costsPaise).toBe(0);
            expect((await account.reconcileAccount({ userId: USER })).ok).toBe(true);
        });
    });

    describe("reconciliation", () => {
        it("holds the ledger identity through a full round trip", async () => {
            await restart(open(DAY1));
            expect((await account.reconcileAccount({ userId: USER })).ok).toBe(true);

            await fill({ side: "BUY", quantity: 100, pricePaise: 300_000, ref: "d1-buy" });
            await openThesis("acct-d1-buy", { quantity: 100, entryPricePaise: 300_000 });
            const held = await account.reconcileAccount({ userId: USER });
            expect(held.ok).toBe(true);
            expect(held.driftPaise).toBe(0);
            expect(held.openPositions).toBe(1);

            await fill({ side: "SELL", quantity: 100, pricePaise: 310_000, ref: "d1-sell" });
            await pool.query(
                "UPDATE trade_thesis SET closed_at=NOW() WHERE user_id=$1", [USER]);
            const flat = await account.reconcileAccount({ userId: USER });
            expect(flat.ok).toBe(true);
            expect(flat.driftPaise).toBe(0);
        });

        it("reports a drifted balance rather than repairing it", async () => {
            await restart(open(DAY1));
            await pool.query(
                "UPDATE users SET balance_paise = balance_paise - 5000 WHERE id=$1", [USER]);

            const result = await account.reconcileAccount({ userId: USER });
            expect(result.ok).toBe(false);
            expect(result.driftPaise).toBe(-5000);
            // The balance is the record. Nothing rewrote it.
            expect(await cash()).toBe(START - 5000);

            const s = await restart(close(DAY1));
            expect(s.reconciliation.ok).toBe(false);
            expect(await cash()).toBe(START - 5000);
            const { rows } = await pool.query(
                "SELECT kind FROM agent_events WHERE user_id=$1 AND kind='RECONCILIATION_FAILED'",
                [USER]);
            expect(rows.length).toBeGreaterThan(0);
        });

        it("notices a position with no open thesis", async () => {
            await restart(open(DAY1));
            await fill({ side: "BUY", quantity: 100, pricePaise: 300_000, ref: "d1-buy" });
            const result = await account.reconcileAccount({ userId: USER });
            expect(result.ok).toBe(false);
            expect(result.checks.find((c) => c.name === "every position has an open thesis").detail)
                .toEqual([SYMBOL]);
        });

        it("cannot place the same order twice after a restart", async () => {
            await restart(open(DAY1));
            const first = await fill({ side: "BUY", quantity: 100, pricePaise: 300_000,
                                       ref: "d1-buy" });
            await openThesis("acct-d1-buy", { quantity: 100, entryPricePaise: 300_000 });
            const afterFirst = await cash();

            // The restarted process re-derives the same intent key.
            await restart(open(DAY1));
            const { order: replay } = await engine.submitOrder({
                userId: USER, symbol: SYMBOL, side: "BUY", quantity: 100,
                pricePaise: 300_000, mode: "INTRADAY",
                clientOrderId: "acct-d1-buy", correlationId: "acct-d1-buy" });

            expect(replay.id).toBe(first.id);
            expect(await cash()).toBe(afterFirst);
            const { rows } = await pool.query(
                "SELECT COUNT(*)::int AS n FROM orders WHERE user_id=$1", [USER]);
            expect(rows[0].n).toBe(1);
            expect((await account.reconcileAccount({ userId: USER })).ok).toBe(true);
        });
    });

    describe("valuation", () => {
        it("reports an unpriced position as unpriced rather than worthless",
           async () => {
            await restart(open(DAY1));
            await fill({ side: "BUY", quantity: 100, pricePaise: 300_000, ref: "d1-buy" });
            await openThesis("acct-d1-buy", { quantity: 100, entryPricePaise: 300_000 });

            const state = await account.accountState({
                userId: USER, priceFor: async () => null });
            expect(state.fullyPriced).toBe(false);
            expect(state.positions[0].priced).toBe(false);
            expect(state.positions[0].valuePaise).toBeNull();
            expect(state.positions[0].unrealisedPnlPaise).toBeNull();
            expect(state.unrealisedPnlPaise).toBe(0);
        });

        it("marks a held position to market", async () => {
            await restart(open(DAY1));
            await fill({ side: "BUY", quantity: 100, pricePaise: 300_000, ref: "d1-buy" });
            await openThesis("acct-d1-buy", { quantity: 100, entryPricePaise: 300_000 });

            const state = await account.accountState({
                userId: USER, priceFor: async () => 304_000 });
            expect(state.fullyPriced).toBe(true);
            expect(state.unrealisedPnlPaise).toBe(400_000);
            expect(state.equityPaise)
                .toBe(state.cashPaise + state.marginUsedPaise + 400_000);
            expect(state.totalPnlPaise).toBe(state.equityPaise - START);
        });
    });

    // A session that took no trades is diagnosed from two fields: what the
    // model proposed, and which gates changed it. Neither was stored, so the
    // 2026-09-01 review had to infer the answer from free text in the thesis
    // and got the causation backwards on the first pass.
    describe("why a decision did not trade", () => {
        it("records the model's proposal alongside the final action", async () => {
            const { buildLivePorts } = await import("../services/autonomous/livePorts.js");
            const ports = buildLivePorts({
                userId: USER, newsStore: null, connectionTracker: null,
                clock: () => open(DAY1) });

            await ports.journal({
                decisionId: "d-gated", correlationId: "c-gated", symbol: SYMBOL,
                route: "CANDIDATE", asOf: open(DAY1),
                decision: {
                    action: "HOLD",              // what survived
                    proposedAction: "BUY",       // what the model wanted
                    entryGates: ["risk/reward 0.84 is below the 1.2 floor for a new position"],
                    confidence: "MEDIUM", reasoning: "breakout holding", evidence: [],
                },
                executed: false,
            });

            const [row] = await account.recentDecisions({ userId: USER });
            expect(row.action).toBe("HOLD");
            expect(row.synthesis.proposedAction).toBe("BUY");
            expect(row.synthesis.entryGates).toEqual([
                "risk/reward 0.84 is below the 1.2 floor for a new position"]);
        });

        it("distinguishes a model that declined from one that was blocked",
           async () => {
            const { buildLivePorts } = await import("../services/autonomous/livePorts.js");
            const ports = buildLivePorts({
                userId: USER, newsStore: null, connectionTracker: null,
                clock: () => open(DAY1) });

            await ports.journal({
                decisionId: "d-declined", correlationId: "c-declined", symbol: "INFY",
                route: "CANDIDATE", asOf: open(DAY1),
                decision: { action: "HOLD", proposedAction: "HOLD", entryGates: [],
                            confidence: "LOW", reasoning: "no edge", evidence: [] },
                executed: false,
            });

            const [row] = await account.recentDecisions({ userId: USER, symbol: "INFY" });
            // Same final action as the gated one above, entirely different cause.
            expect(row.action).toBe("HOLD");
            expect(row.synthesis.proposedAction).toBe("HOLD");
            expect(row.synthesis.entryGates).toEqual([]);
        });
    });
});
