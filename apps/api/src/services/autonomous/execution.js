import { pool } from "../../config/db.js";
import { executeBuy, executeSell } from "../tradingEngine.js";

// Binds the autonomous loop's `execute` port to the existing paper engine.
//
// This is an ADAPTER, not an execution implementation. tradingEngine.js stays
// authoritative for order placement, cash and position accounting; nothing
// here writes to portfolio, users or orders directly. Its whole job is to
// translate an approved intent into that engine's call shape and to make the
// call idempotent.
//
// KNOWN LIMITATION, stated rather than hidden: tradingEngine is an immediate,
// transactional fill. It has no order state machine, no reservations and no
// partial fills. The P4/P5 state machine with those guarantees lives in the
// Python core over SQLite, which does not share a datastore with the Postgres
// `portfolio` this loop monitors. Wiring the loop there would put positions
// somewhere the monitor cannot see them. See docs/EXECUTION_BOUNDARY.md.

export class ExecutionRefused extends Error {}

export const orderForClientId = async (clientOrderId) => {
    const { rows } = await pool.query(
        "SELECT id, symbol, type, quantity, price_paise FROM orders WHERE client_order_id = $1",
        [clientOrderId]);
    return rows[0] ?? null;
};

export const paperExecutor = ({ userId, mode = "INTRADAY" }) => async (intent) => {
    if (!intent?.clientOrderId)
        throw new ExecutionRefused("intent has no clientOrderId; refusing a non-idempotent order");

    // Idempotency check first. A duplicate decision must not place a second
    // order, and must not look like a failure either.
    const existing = await orderForClientId(intent.clientOrderId);
    if (existing) return { duplicate: true, orderId: existing.id, symbol: existing.symbol };

    const place = intent.side === "BUY" ? executeBuy : executeSell;
    try {
        const result = await place(
            userId, intent.symbol, intent.quantity, mode, intent.decisionId ?? null,
            { clientOrderId: intent.clientOrderId, correlationId: intent.correlationId ?? null });
        return { duplicate: false, ...result };
    } catch (err) {
        // Unique violation on client_order_id: a concurrent cycle placed this
        // exact order first. The transaction rolled back, so nothing was
        // double-counted, and this call is the duplicate.
        if (err.code === "23505") {
            const winner = await orderForClientId(intent.clientOrderId);
            return { duplicate: true, orderId: winner?.id ?? null };
        }
        throw err;
    }
};
