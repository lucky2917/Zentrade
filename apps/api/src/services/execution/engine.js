import { pool } from "../../config/db.js";
import {
    lockCash, applyCashDelta, readPositionForUpdate, addToPosition, reducePosition,
    insertPendingOrder, updateOrderProgress,
} from "./bookkeeper.js";
import { STATES, assertTransition, isTerminal, stateAfterFill, InvalidTransition } from "./states.js";
import {
    BROKERAGE_PAISE, buyMarginPaise, buyDebitPaise, buyObligationPaise, sellCreditPaise,
    remainingMarginPaise,
} from "./ledger.js";

// The Postgres execution engine.
//
// Owns the order lifecycle, fills, reservations, cash and positions, and keeps
// them consistent inside single transactions. It replaces the immediate-fill
// path for the autonomous route; tradingEngine.js remains for the human API
// route until that is migrated separately.
//
// Cash model:
//   users.balance_paise   total settled cash, changes only when a fill settles
//   orders.reserved_paise cash held against an order's REMAINING obligation
//   available             balance - SUM(reserved) over non-terminal orders
//
// Lock order is always users -> orders -> portfolio, matching tradingEngine, so
// the two engines cannot deadlock against each other.

export class ExecutionError extends Error {}
export class InsufficientCash extends ExecutionError {}
export class DuplicateFill extends ExecutionError {}
export const OPEN_STATES = [STATES.NEW, STATES.ACCEPTED, STATES.WORKING,
                            STATES.PARTIALLY_FILLED, STATES.AMBIGUOUS];

const withTransaction = async (fn) => {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
};

export const availableCashPaise = async (userId, client = pool) => {
    const { rows } = await client.query(
        `SELECT u.balance_paise
              - COALESCE((SELECT SUM(o.reserved_paise) FROM orders o
                          WHERE o.user_id = u.id AND o.state = ANY($2)), 0) AS available
         FROM users u WHERE u.id = $1`, [userId, OPEN_STATES]);
    return rows.length ? Number(rows[0].available) : 0;
};

// What a BUY of this size commits at the reference price. The reservation
// prices the spread the buyer will pay, so it always covers the eventual
// debit. Both come from the shared ledger, so they cannot drift apart.
export const obligationPaise = ({ side, quantity, pricePaise, mode }) => {
    if (side === "SELL") return 0; // selling releases cash; nothing to reserve
    return buyObligationPaise({ quantity, pricePaise, mode });
};

export const submitOrder = async ({
    userId, symbol, side, quantity, pricePaise, mode = "INTRADAY",
    clientOrderId, correlationId = null, decisionId = null, thesisId = null,
    orderType = "MARKET", limitPricePaise = null, expiresAt = null,
}) => {
    if (!clientOrderId) throw new ExecutionError("clientOrderId is required");
    if (!Number.isInteger(quantity) || quantity <= 0)
        throw new ExecutionError("quantity must be a positive integer");
    if (!Number.isFinite(pricePaise) || pricePaise <= 0)
        throw new ExecutionError("reference price is required");

    return withTransaction(async (client) => {
        // Idempotency: a repeat submission returns the original order and
        // reserves nothing further.
        const existing = await client.query(
            "SELECT * FROM orders WHERE client_order_id = $1", [clientOrderId]);
        if (existing.rows.length) return { order: existing.rows[0], duplicate: true };

        await lockCash(client, userId);

        const reserve = obligationPaise({ side, quantity, pricePaise, mode });
        const available = await availableCashPaise(userId, client);
        if (reserve > available)
            throw new InsufficientCash(
                `need ${reserve} paise, ${available} available after existing reservations`);

        // Two callers can pass the existence check before either inserts. The
        // unique index settles it; losing that race must return the winner's
        // order, not an error, or idempotency holds only when uncontended.
        const inserted = await insertPendingOrder(client, {
            userId, symbol, side, quantity, pricePaise,
            totalValuePaise: pricePaise * quantity, brokeragePaise: BROKERAGE_PAISE,
            mode, decisionId, clientOrderId, correlationId, thesisId,
            reservedPaise: reserve, orderType, limitPricePaise,
            referencePricePaise: pricePaise, expiresAt,
        });

        if (!inserted) {
            const winner = await client.query(
                "SELECT * FROM orders WHERE client_order_id = $1", [clientOrderId]);
            return { order: winner.rows[0], duplicate: true };
        }

        return { order: inserted, duplicate: false };
    });
};

const transitionTo = async (client, orderId, nextState, patch = {}) => {
    const { rows } = await client.query(
        "SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
    if (!rows.length) throw new ExecutionError(`unknown order ${orderId}`);
    const order = rows[0];
    assertTransition(order.state, nextState);

    const sets = ["state = $2", "last_update_at = NOW()"];
    const params = [orderId, nextState];
    let i = 3;
    for (const [column, value] of Object.entries(patch)) {
        sets.push(`${column} = $${i}`); params.push(value); i += 1;
    }
    if (nextState === STATES.ACCEPTED) sets.push("accepted_at = NOW()");
    if (nextState === STATES.WORKING) sets.push("working_at = NOW()");
    if (isTerminal(nextState)) { sets.push("completed_at = NOW()"); sets.push("reserved_paise = 0"); }

    const updated = await client.query(
        `UPDATE orders SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
    return updated.rows[0];
};

export const acceptOrder = (orderId) =>
    withTransaction((c) => transitionTo(c, orderId, STATES.ACCEPTED));

export const workOrder = (orderId) =>
    withTransaction((c) => transitionTo(c, orderId, STATES.WORKING));

export const rejectOrder = (orderId, reason) =>
    withTransaction((c) => transitionTo(c, orderId, STATES.REJECTED, { rejection_reason: reason }));

export const cancelOrder = (orderId) =>
    withTransaction((c) => transitionTo(c, orderId, STATES.CANCELLED));

export const expireOrder = (orderId) =>
    withTransaction((c) => transitionTo(c, orderId, STATES.EXPIRED));

export const markAmbiguous = (orderId, reason) =>
    withTransaction((c) => transitionTo(c, orderId, STATES.AMBIGUOUS, { ambiguity_reason: reason }));

// Applying a fill is the only place cash and positions move. Order, fill,
// cash and position all change in one transaction or none of them do.
export const applyFill = async ({
    orderId, executionRef, quantity, pricePaise, correlationId = null, source = "paper",
}) => {
    if (!executionRef) throw new ExecutionError("executionRef is required for fill identity");
    if (!Number.isInteger(quantity) || quantity <= 0)
        throw new ExecutionError("fill quantity must be a positive integer");

    return withTransaction(async (client) => {
        const { rows } = await client.query(
            "SELECT * FROM orders WHERE id = $1 FOR UPDATE", [orderId]);
        if (!rows.length) throw new ExecutionError(`unknown order ${orderId}`);
        const order = rows[0];

        // A repeated broker callback must be absorbed, not double-counted.
        const seen = await client.query(
            "SELECT id FROM order_fills WHERE order_id = $1 AND execution_ref = $2",
            [orderId, executionRef]);
        if (seen.rows.length) return { order, duplicate: true };

        if (![STATES.WORKING, STATES.PARTIALLY_FILLED].includes(order.state))
            throw new InvalidTransition(order.state, "fill");

        const filled = Number(order.filled_quantity) + quantity;
        if (filled > Number(order.quantity))
            throw new ExecutionError(
                `overfill: ${filled} of ${order.quantity} on order ${orderId}`);

        await lockCash(client, order.user_id);

        await client.query(
            `INSERT INTO order_fills (order_id, execution_ref, symbol, side, quantity,
                                      price_paise, brokerage_paise, correlation_id, source)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [orderId, executionRef, order.symbol, order.type, quantity, pricePaise,
             0, correlationId ?? order.correlation_id, source]);

        const nextState = stateAfterFill(Number(order.quantity), filled);
        const remaining = Number(order.quantity) - filled;

        // The reservation must track only what is still owed.
        const reserved = isTerminal(nextState) ? 0 : obligationPaise({
            side: order.type, quantity: remaining,
            pricePaise: Number(order.reference_price_paise ?? order.price_paise),
            mode: order.order_mode,
        });

        // Brokerage is charged once per order, on the fill that opens it, so a
        // partially filled order is not billed twice.
        const chargeBrokerage = Number(order.filled_quantity) === 0;

        if (order.type === "BUY") {
            const margin = buyMarginPaise({ quantity, pricePaise, mode: order.order_mode });
            const debit = buyDebitPaise({
                quantity, pricePaise, mode: order.order_mode, chargeBrokerage });
            await applyCashDelta(client, order.user_id, -debit);
            // The margin this fill consumed is recorded on the row, because the
            // exit needs to know what to release. Omitting it is what made a
            // position closed by the legacy path destroy its own principal.
            await addToPosition(client, {
                userId: order.user_id, symbol: order.symbol, mode: order.order_mode,
                quantity, pricePaise, marginPaise: margin });
        } else {
            const held = await readPositionForUpdate(client, {
                userId: order.user_id, symbol: order.symbol, mode: order.order_mode });
            const have = held?.quantity ?? 0;
            if (quantity > have)
                throw new ExecutionError(
                    `sell fill of ${quantity} exceeds holding of ${have}; would create a negative position`);

            const { avgPricePaise, marginUsedPaise } = held;
            const credit = sellCreditPaise({
                quantity, heldQuantity: have, marginUsedPaise, avgPricePaise, pricePaise,
                mode: order.order_mode, chargeBrokerage });
            await applyCashDelta(client, order.user_id, credit);

            await reducePosition(client, {
                userId: order.user_id, symbol: order.symbol, mode: order.order_mode,
                quantity, heldQuantity: have,
                remainingMarginPaise: remainingMarginPaise({
                    quantity, heldQuantity: have, marginUsedPaise }) });
        }

        const updated = await updateOrderProgress(client, {
            orderId, state: nextState, filledQuantity: filled, reservedPaise: reserved });

        return { order: updated, duplicate: false };
    });
};

// Reconciliation may move an order to whatever state the venue reports, as
// long as the transition table allows it. This is the only sanctioned way out
// of AMBIGUOUS.
export const resolveTo = (orderId, state) =>
    withTransaction((c) => transitionTo(c, orderId, state));

export const getOrder = async (orderId) => {
    const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
    return rows[0] ?? null;
};

export const fillsFor = async (orderId) => {
    const { rows } = await pool.query(
        "SELECT * FROM order_fills WHERE order_id=$1 ORDER BY filled_at, id", [orderId]);
    return rows;
};

export const openOrders = async (userId) => {
    const { rows } = await pool.query(
        "SELECT * FROM orders WHERE user_id=$1 AND state = ANY($2) ORDER BY id", [userId, OPEN_STATES]);
    return rows;
};

// Orders past their expiry that are still resting. Expiry releases the
// reservation; it never fabricates a rejection, because the venue did not
// refuse anything.
export const expireStaleOrders = async (now = new Date()) => {
    const { rows } = await pool.query(
        `SELECT id FROM orders
         WHERE expires_at IS NOT NULL AND expires_at <= $1
           AND state IN ('ACCEPTED','WORKING','PARTIALLY_FILLED')`, [now]);
    const expired = [];
    for (const row of rows) { expired.push(await expireOrder(row.id)); }
    return expired;
};
