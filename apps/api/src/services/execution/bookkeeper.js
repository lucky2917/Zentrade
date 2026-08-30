// The single writer for cash, positions and order rows.
//
// Three modules wrote these tables with their own SQL: the execution engine,
// the manual trading path and the end-of-day square-off. The arithmetic was
// already shared through ledger.js, so the money was right, but the WRITES were
// not: each had its own INSERT with its own column list, and a migration that
// added a NOT NULL column broke exactly one of them, in production, at 15:25.
//
// Everything that mutates `users.balance_paise`, `portfolio` or `orders` goes
// through this module. The state machine in engine.js still owns which
// transitions are legal; this owns how a row is written once they are.
//
// The rule is enforced by a test, not by convention: singleWriter.test.js fails
// if this SQL reappears anywhere else.

import { STATES, isTerminal } from "./states.js";

// Cash may only move under a row lock. Taking it in one place is what makes the
// lock ordering consistent across every caller, which is what stops two
// concurrent trades on one account from deadlocking.
export const lockCash = (client, userId) =>
    client.query("SELECT balance_paise FROM users WHERE id = $1 FOR UPDATE", [userId]);

// A single signed delta rather than a credit and a debit. Two functions that
// differ only in sign are two chances to apply the wrong one.
export const applyCashDelta = async (client, userId, deltaPaise) => {
    if (!Number.isInteger(deltaPaise)) {
        throw new TypeError(`cash delta must be integer paise, got ${deltaPaise}`);
    }
    if (deltaPaise === 0) return;
    await client.query(
        "UPDATE users SET balance_paise = balance_paise + $1 WHERE id = $2",
        [deltaPaise, userId]);
};

export const readPositionForUpdate = async (client, { userId, symbol, mode }) => {
    const { rows } = await client.query(
        `SELECT id, quantity, avg_price_paise, margin_used_paise FROM portfolio
         WHERE user_id = $1 AND symbol = $2 AND order_mode = $3 FOR UPDATE`,
        [userId, symbol, mode]);
    if (!rows.length) return null;
    return {
        id: rows[0].id,
        quantity: Number(rows[0].quantity),
        avgPricePaise: Number(rows[0].avg_price_paise),
        marginUsedPaise: Number(rows[0].margin_used_paise ?? 0),
    };
};

// Opening or adding to a position. The upsert is atomic because two concurrent
// first buys on one symbol would otherwise both see no row and both insert.
//
// `marginPaise` is recorded because the exit needs to know what to release.
// Omitting it is what made a position opened by one path and closed by another
// destroy its own principal.
export const addToPosition = async (client, {
    userId, symbol, mode, quantity, pricePaise, marginPaise,
}) => {
    await client.query(
        `INSERT INTO portfolio (user_id, symbol, quantity, avg_price_paise, order_mode,
                                margin_used_paise)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, symbol, order_mode) DO UPDATE SET
           quantity          = portfolio.quantity + EXCLUDED.quantity,
           avg_price_paise   = (portfolio.quantity * portfolio.avg_price_paise
                                + EXCLUDED.quantity * EXCLUDED.avg_price_paise)
                               / (portfolio.quantity + EXCLUDED.quantity),
           margin_used_paise = portfolio.margin_used_paise + EXCLUDED.margin_used_paise,
           updated_at        = NOW()`,
        [userId, symbol, quantity, pricePaise, mode, marginPaise]);
};

// Reducing or closing. A full exit deletes the row; a partial keeps the margin
// apportioned by the same rule the credit was computed with, so the two cannot
// disagree and leak margin.
export const reducePosition = async (client, {
    userId, symbol, mode, quantity, heldQuantity, remainingMarginPaise,
}) => {
    if (quantity > heldQuantity) {
        throw new RangeError(
            `reducing ${quantity} of a ${heldQuantity} holding would create a negative position`);
    }
    if (quantity === heldQuantity) {
        await client.query(
            "DELETE FROM portfolio WHERE user_id=$1 AND symbol=$2 AND order_mode=$3",
            [userId, symbol, mode]);
        return;
    }
    await client.query(
        `UPDATE portfolio SET quantity = quantity - $3, margin_used_paise = $4,
                updated_at = NOW()
         WHERE user_id=$1 AND symbol=$2 AND order_mode=$5`,
        [userId, symbol, quantity, remainingMarginPaise, mode]);
};

// The square-off holds the position row it already locked, so it closes by id
// rather than re-resolving the natural key.
export const closePositionById = (client, positionId) =>
    client.query("DELETE FROM portfolio WHERE id = $1", [positionId]);

// Every column the order table requires, in one place.
//
// A row is written either as work in progress (the state machine will advance
// it) or as an already-completed trade (the immediate-fill paths). Both shapes
// come from here so a schema change lands on one INSERT instead of three.
const ORDER_COLUMNS = `user_id, symbol, type, quantity, price_paise, total_value_paise,
    brokerage_paise, order_mode, decision_id, client_order_id, correlation_id, thesis_id,
    state, filled_quantity, reserved_paise, order_type, limit_price_paise,
    reference_price_paise, pnl_paise, expires_at, completed_at, last_update_at`;

const orderValues = ({
    userId, symbol, side, quantity, pricePaise, totalValuePaise, brokeragePaise, mode,
    decisionId = null, clientOrderId = null, correlationId = null, thesisId = null,
    state, filledQuantity, reservedPaise, orderType = "MARKET", limitPricePaise = null,
    referencePricePaise = null, pnlPaise = null, expiresAt = null,
}) => [
    userId, symbol, side, quantity, pricePaise, totalValuePaise, brokeragePaise, mode,
    decisionId, clientOrderId, correlationId, thesisId,
    state, filledQuantity, reservedPaise, orderType, limitPricePaise,
    referencePricePaise, pnlPaise, expiresAt,
];

// Work in progress. Conflict on client_order_id yields nothing so the caller
// can fetch the winner: losing an idempotency race must return the winner's
// order, not an error.
export const insertPendingOrder = async (client, params) => {
    const { rows } = await client.query(
        `INSERT INTO orders (${ORDER_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                 NULL, NOW())
         ON CONFLICT (client_order_id) WHERE client_order_id IS NOT NULL DO NOTHING
         RETURNING *`,
        orderValues({ ...params, state: STATES.NEW, filledQuantity: 0 }));
    return rows[0] ?? null;
};

// An already-completed trade: the manual path and the square-off fill
// synchronously and have no venue to acknowledge them. The row still carries
// every state-machine column, so it is indistinguishable downstream from an
// order the engine drove to the same place.
export const insertCompletedOrder = async (client, params) => {
    const state = params.state ?? STATES.FILLED;
    if (!isTerminal(state)) {
        throw new RangeError(`insertCompletedOrder needs a terminal state, got ${state}`);
    }
    const { rows } = await client.query(
        `INSERT INTO orders (${ORDER_COLUMNS})
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                 NOW(), NOW())
         RETURNING id`,
        orderValues({
            ...params, state,
            filledQuantity: params.filledQuantity ?? params.quantity,
            reservedPaise: 0,
            referencePricePaise: params.referencePricePaise ?? params.pricePaise,
        }));
    return rows[0];
};

// Advancing an order the state machine already validated.
export const updateOrderProgress = async (client, {
    orderId, state, filledQuantity, reservedPaise,
}) => {
    const { rows } = await client.query(
        `UPDATE orders SET state=$2::varchar, filled_quantity=$3, reserved_paise=$4,
                last_update_at=NOW(),
                completed_at = CASE WHEN $2::varchar = 'FILLED' THEN NOW()
                                    ELSE completed_at END
         WHERE id=$1 RETURNING *`,
        [orderId, state, filledQuantity, reservedPaise]);
    return rows[0];
};
