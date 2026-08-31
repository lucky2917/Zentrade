import { pool } from "../../config/db.js";

// The persistent paper-trading account.
//
// One continuous account, opened once and carried across restarts, crashes and
// trading days. Nothing here resets anything: the starting capital is written
// at opening and never updated, and cash is only ever moved by the bookkeeper.
//
// A day boundary is a REPORTING boundary, not an accounting one. Yesterday's
// closing cash is today's opening cash because it is the same number in the
// same row — there is no carry-forward step that could fail to run, and no
// reset that could run by mistake.

export const DEFAULT_STARTING_CAPITAL_PAISE = 100_000_000;   // Rs 10,00,000

// Which orders actually moved money.
//
// NOT state='FILLED'. An order that filled part way and then expired or was
// cancelled settled cash, booked P&L and paid brokerage exactly like a complete
// one; excluding it understated realised P&L and costs and showed up as
// reconciliation drift on an account that was correct.
const SETTLED = "filled_quantity > 0";

const IST_OFFSET = "5 hours 30 minutes";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export const sessionDateOf = (at = new Date()) =>
    new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

const ACCOUNT_COLUMNS = `user_id, starting_capital_paise, opening_adjustment_paise,
    currency, opened_at, mode`;

// Opens the account if it has never been opened. Idempotent by primary key, so
// two processes starting together cannot create two accounts or move the
// reference the whole P&L is measured against.
//
// The opening adjustment is measured in the same statement, from the cash that
// is already there. An account opened on an untouched balance gets zero; one
// opened over existing history gets whatever that history moved but never
// recorded against an order, so the ledger identity holds from the first
// moment and any drift after it is a real fault rather than inherited noise.
export const ensureAccount = async ({
    userId, startingCapitalPaise = DEFAULT_STARTING_CAPITAL_PAISE, db = pool,
} = {}) => {
    const { rows } = await db.query(
        `INSERT INTO paper_account (user_id, starting_capital_paise, opening_adjustment_paise)
         SELECT $1, $2,
                (SELECT balance_paise FROM users WHERE id = $1) - $2
                - COALESCE((SELECT SUM(pnl_paise) FROM orders
                            WHERE user_id = $1 AND ${SETTLED}), 0)
                + COALESCE((SELECT SUM(brokerage_paise) FROM orders
                            WHERE user_id = $1 AND ${SETTLED}), 0)
                + COALESCE((SELECT SUM(margin_used_paise) FROM portfolio
                            WHERE user_id = $1 AND quantity > 0), 0)
         WHERE EXISTS (SELECT 1 FROM users WHERE id = $1)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING ${ACCOUNT_COLUMNS}`,
        [userId, startingCapitalPaise]);
    if (rows.length) return { ...rows[0], opened: true };
    const existing = await db.query(
        `SELECT ${ACCOUNT_COLUMNS} FROM paper_account WHERE user_id = $1`, [userId]);
    return { ...existing.rows[0], opened: false };
};

// Everything the account is worth right now. `priceFor` is injected so this can
// be valued against live prices, a replayed session, or nothing at all — a
// position whose price is unknown is reported as unknown, never valued at a
// guess.
export const accountState = async ({ userId, priceFor = async () => null, db = pool } = {}) => {
    const [account, user, positions, realised] = await Promise.all([
        db.query(`SELECT starting_capital_paise, opening_adjustment_paise, opened_at
                  FROM paper_account WHERE user_id=$1`, [userId]),
        db.query("SELECT balance_paise FROM users WHERE id=$1", [userId]),
        db.query(`SELECT symbol, quantity, avg_price_paise, margin_used_paise, order_mode
                  FROM portfolio WHERE user_id=$1 AND quantity > 0 ORDER BY symbol`, [userId]),
        db.query(`SELECT COALESCE(SUM(pnl_paise),0) AS pnl,
                         COALESCE(SUM(brokerage_paise),0) AS costs,
                         COUNT(*)::int AS orders
                  FROM orders WHERE user_id=$1 AND ${SETTLED}`, [userId]),
    ]);
    if (!account.rows.length || !user.rows.length) return null;

    const startingCapitalPaise = Number(account.rows[0].starting_capital_paise);
    const openingAdjustmentPaise = Number(account.rows[0].opening_adjustment_paise);
    const cashPaise = Number(user.rows[0].balance_paise);

    let positionValuePaise = 0, unrealisedPnlPaise = 0, marginUsedPaise = 0, valued = 0;
    const held = [];
    for (const row of positions.rows) {
        const quantity = Number(row.quantity);
        const avgPricePaise = Number(row.avg_price_paise);
        const margin = Number(row.margin_used_paise ?? 0);
        marginUsedPaise += margin;

        const lastPaise = await priceFor(row.symbol);
        const priced = Number.isFinite(lastPaise) && lastPaise > 0;
        const value = priced ? lastPaise * quantity : null;
        const pnl = priced ? (lastPaise - avgPricePaise) * quantity : null;
        if (priced) { positionValuePaise += value; unrealisedPnlPaise += pnl; valued += 1; }

        held.push({
            symbol: row.symbol, quantity, avgPricePaise, marginUsedPaise: margin,
            mode: row.order_mode, lastPricePaise: priced ? lastPaise : null,
            valuePaise: value, unrealisedPnlPaise: pnl,
            // A position we cannot price is not worth zero. It is worth an
            // amount we do not currently know, and the cockpit says so.
            priced,
        });
    }

    // Intraday margin means the cash line already excludes what is committed to
    // open positions, so equity adds the margin back and marks to market on top.
    const equityPaise = cashPaise + marginUsedPaise + unrealisedPnlPaise;

    return {
        userId, mode: "PAPER", startingCapitalPaise,
        openedAt: account.rows[0].opened_at,
        cashPaise, marginUsedPaise, positionValuePaise, equityPaise,
        // Everything the account has realised, including what it realised
        // before any of it was written down. The split is reported too, so the
        // unattributable part is visible rather than blended away.
        realisedPnlPaise: Number(realised.rows[0].pnl) + openingAdjustmentPaise,
        openingAdjustmentPaise,
        unrealisedPnlPaise,
        costsPaise: Number(realised.rows[0].costs),
        totalPnlPaise: equityPaise - startingCapitalPaise,
        settledOrders: realised.rows[0].orders,
        positions: held,
        fullyPriced: valued === positions.rows.length,
    };
};

// The auditable record of one decision.
//
// Append-only, and idempotent on the DECISION id, not the correlation id. A
// position's reassessments all share one correlation id — that is what ties
// them together — so keying identity on it stored the first decision and
// discarded the rest.
export const recordDecision = async ({ userId, record, db = pool }) => {
    const { rows } = await db.query(
        `INSERT INTO decision_records (
            user_id, decision_id, correlation_id, session_date, symbol, route,
            trigger_type, trigger_severity, trigger_reason, action, confidence,
            evidence, thesis, supporting, contradicting, counter_thesis,
            alternatives, what_would_change, challenge_verdict, synthesis,
            risk_decision, risk_code, risk_reason, executed, blocked_reason,
            thesis_id, price_paise, quantity, decided_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15::jsonb,
                 $16,$17::jsonb,$18::jsonb,$19,$20::jsonb,$21,$22,$23,$24,$25,$26,
                 $27,$28,$29)
         ON CONFLICT (decision_id) DO NOTHING RETURNING id`,
        [userId, record.decisionId ?? record.correlationId, record.correlationId,
         record.sessionDate ?? sessionDateOf(record.decidedAt ?? new Date()),
         record.symbol, record.route ?? "CANDIDATE",
         record.triggerType ?? null, record.triggerSeverity ?? null, record.triggerReason ?? null,
         record.action, record.confidence ?? null,
         JSON.stringify(record.evidence ?? []), record.thesis ?? null,
         JSON.stringify(record.supporting ?? []), JSON.stringify(record.contradicting ?? []),
         record.counterThesis ?? null, JSON.stringify(record.alternatives ?? []),
         JSON.stringify(record.whatWouldChange ?? []), record.challengeVerdict ?? null,
         JSON.stringify(record.synthesis ?? {}),
         record.riskDecision ?? null, record.riskCode ?? null, record.riskReason ?? null,
         Boolean(record.executed), record.blockedReason ?? null,
         record.thesisId ?? null, record.pricePaise ?? null, record.quantity ?? null,
         record.decidedAt ?? new Date()]);
    return rows[0] ?? null;
};

export const recentDecisions = async ({ userId, limit = 50, symbol = null, db = pool }) => {
    const { rows } = await db.query(
        `SELECT * FROM decision_records WHERE user_id = $1
         AND ($2::text IS NULL OR symbol = $2)
         ORDER BY decided_at DESC LIMIT $3`, [userId, symbol, Math.min(limit, 200)]);
    return rows;
};

// Durable runtime events, so a restart or a crash is visible after the fact
// rather than only in a log file that may have rolled.
export const recordAgentEvent = async ({ userId, kind, detail = {}, at = new Date(), db = pool }) => {
    await db.query(
        `INSERT INTO agent_events (user_id, session_date, kind, detail, occurred_at)
         VALUES ($1,$2,$3,$4::jsonb,$5)`,
        [userId, sessionDateOf(at), kind, JSON.stringify(detail), at]);
};

// Written through the day and finalised at close. Upsert on the session date,
// so running it twice cannot create a second row for one day and a crash
// mid-session does not lose the day.
export const writeSessionSummary = async ({ userId, state, at = new Date(), db = pool }) => {
    const sessionDate = sessionDateOf(at);
    // The session is an IST day, and the bounds say so rather than relying on
    // the database server's timezone happening to be UTC.
    const counts = await db.query(
        `SELECT COUNT(*)::int AS orders_placed,
                COUNT(*) FILTER (WHERE type='BUY')::int  AS opened,
                COUNT(*) FILTER (WHERE type='SELL')::int AS closed,
                COALESCE(SUM(pnl_paise),0) AS realised,
                COALESCE(SUM(brokerage_paise),0) AS costs
         FROM orders
         WHERE user_id = $1 AND ${SETTLED}
           AND created_at >= ($2::date::timestamp - $3::interval) AT TIME ZONE 'UTC'
           AND created_at <  ($2::date::timestamp + interval '1 day' - $3::interval)
                             AT TIME ZONE 'UTC'`,
        [userId, sessionDate, IST_OFFSET]);
    const decisions = await db.query(
        "SELECT COUNT(*)::int AS n FROM decision_records WHERE user_id=$1 AND session_date=$2",
        [userId, sessionDate]);
    const c = counts.rows[0];

    // Opening cash is recorded once, on the first write of the day, and never
    // overwritten — that is what makes the day's movement recoverable.
    await db.query(
        `INSERT INTO session_summaries (
            user_id, session_date, opening_cash_paise, closing_cash_paise,
            opening_equity_paise, closing_equity_paise, realised_pnl_paise,
            unrealised_pnl_paise, costs_paise, orders_placed, positions_opened,
            positions_closed, decisions_made, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
         ON CONFLICT (user_id, session_date) DO UPDATE SET
           closing_cash_paise   = EXCLUDED.closing_cash_paise,
           closing_equity_paise = EXCLUDED.closing_equity_paise,
           realised_pnl_paise   = EXCLUDED.realised_pnl_paise,
           unrealised_pnl_paise = EXCLUDED.unrealised_pnl_paise,
           costs_paise          = EXCLUDED.costs_paise,
           orders_placed        = EXCLUDED.orders_placed,
           positions_opened     = EXCLUDED.positions_opened,
           positions_closed     = EXCLUDED.positions_closed,
           decisions_made       = EXCLUDED.decisions_made,
           updated_at           = NOW()`,
        [userId, sessionDate, state.cashPaise, state.cashPaise,
         state.equityPaise, state.equityPaise, Number(c.realised),
         state.unrealisedPnlPaise, Number(c.costs), c.orders_placed,
         c.opened, c.closed, decisions.rows[0].n]);
    return sessionDate;
};

export const sessionHistory = async ({ userId, limit = 30, db = pool }) => {
    const { rows } = await db.query(
        `SELECT * FROM session_summaries WHERE user_id=$1
         ORDER BY session_date DESC LIMIT $2`, [userId, Math.min(limit, 120)]);
    return rows;
};

// ---- reconciliation ---------------------------------------------------------
//
// A restart must be able to prove it resumed the same account rather than
// assume it. These checks are derived from independent sources — the cash row,
// the order history, the position rows — so a disagreement means something is
// genuinely wrong and not merely reported twice.
//
// Nothing here writes to money. A reconciliation that silently "corrects" a
// balance destroys the evidence of the bug that caused the drift.

export const LEDGER_IDENTITY =
    "cash = starting capital + opening adjustment + realised P&L - costs"
    + " - margin committed to open positions";

export const reconcileAccount = async ({ userId, db = pool } = {}) => {
    const [account, user, margin, realised, duplicates, orphans] = await Promise.all([
        db.query(`SELECT starting_capital_paise, opening_adjustment_paise
                  FROM paper_account WHERE user_id=$1`, [userId]),
        db.query("SELECT balance_paise FROM users WHERE id=$1", [userId]),
        db.query(`SELECT COALESCE(SUM(margin_used_paise),0) AS m, COUNT(*)::int AS n
                  FROM portfolio WHERE user_id=$1 AND quantity > 0`, [userId]),
        db.query(`SELECT COALESCE(SUM(pnl_paise),0) AS pnl,
                         COALESCE(SUM(brokerage_paise),0) AS costs
                  FROM orders WHERE user_id=$1 AND ${SETTLED}`, [userId]),
        db.query(`SELECT client_order_id, COUNT(*)::int AS n FROM orders
                  WHERE user_id=$1 AND client_order_id IS NOT NULL
                  GROUP BY client_order_id HAVING COUNT(*) > 1`, [userId]),
        db.query(`SELECT p.symbol FROM portfolio p
                  WHERE p.user_id=$1 AND p.quantity > 0 AND NOT EXISTS (
                      SELECT 1 FROM trade_thesis t
                      WHERE t.user_id = p.user_id AND t.symbol = p.symbol
                        AND t.closed_at IS NULL)`, [userId]),
    ]);

    if (!account.rows.length) {
        return { ok: false, checks: [{ name: "account", ok: false,
                                       detail: "no paper account for this user" }] };
    }

    const startingCapitalPaise = Number(account.rows[0].starting_capital_paise);
    const openingAdjustmentPaise = Number(account.rows[0].opening_adjustment_paise);
    const cashPaise = Number(user.rows[0].balance_paise);
    const marginPaise = Number(margin.rows[0].m);
    const expectedCashPaise = startingCapitalPaise + openingAdjustmentPaise
        + Number(realised.rows[0].pnl) - Number(realised.rows[0].costs) - marginPaise;
    const driftPaise = cashPaise - expectedCashPaise;

    const checks = [
        { name: "ledger", ok: driftPaise === 0, identity: LEDGER_IDENTITY,
          detail: { cashPaise, expectedCashPaise, driftPaise, startingCapitalPaise,
                    openingAdjustmentPaise,
                    realisedPnlPaise: Number(realised.rows[0].pnl),
                    costsPaise: Number(realised.rows[0].costs), marginPaise } },
        // The database enforces this with a unique index; the check exists so a
        // restart says so out loud rather than trusting that it still does.
        { name: "no duplicate orders", ok: duplicates.rows.length === 0,
          detail: duplicates.rows },
        { name: "every position has an open thesis", ok: orphans.rows.length === 0,
          detail: orphans.rows.map((r) => r.symbol) },
    ];

    return {
        ok: checks.every((c) => c.ok),
        openPositions: margin.rows[0].n,
        driftPaise,
        checks,
    };
};
