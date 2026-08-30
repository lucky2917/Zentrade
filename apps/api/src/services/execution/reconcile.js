import { pool } from "../../config/db.js";
import { STATES, isTerminal, canTransition } from "./states.js";
import {
    openOrders, applyFill, markAmbiguous, getOrder, resolveTo,
} from "./engine.js";

// Reconciliation compares internal belief with external truth.
//
// The governing rule: when external truth cannot be established, the answer is
// AMBIGUOUS, not a guess. An engine that assumes "probably not filled" will
// eventually double-submit; one that assumes "probably filled" will eventually
// invent a position. Both are worse than stopping.

export const OUTCOME = { MATCHED: "MATCHED", MISMATCH: "MISMATCH", AMBIGUOUS: "AMBIGUOUS" };

const record = async (order, outcome, externalState, externalFilled, detail) => {
    await pool.query(
        `INSERT INTO order_reconciliations
           (order_id, outcome, internal_state, external_state, internal_filled, external_filled, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [order.id, outcome, order.state, externalState ?? null,
         Number(order.filled_quantity), externalFilled ?? null, detail]);
};

// `external` is null when the venue could not be reached or gave no answer.
export const reconcileOrder = async (orderId, external) => {
    const order = await getOrder(orderId);
    if (!order) throw new Error(`unknown order ${orderId}`);

    if (external === null || external === undefined) {
        const detail = "external state unavailable; truth not established";
        await record(order, OUTCOME.AMBIGUOUS, null, null, detail);
        if (!isTerminal(order.state) && order.state !== STATES.AMBIGUOUS) {
            await markAmbiguous(orderId, detail);
        }
        return { outcome: OUTCOME.AMBIGUOUS, order: await getOrder(orderId) };
    }

    const internalFilled = Number(order.filled_quantity);
    const externalFilled = Number(external.filledQuantity ?? 0);

    if (external.state === order.state && externalFilled === internalFilled) {
        await record(order, OUTCOME.MATCHED, external.state, externalFilled, "states agree");
        return { outcome: OUTCOME.MATCHED, order };
    }

    // The venue saw fills we did not. Applying them is safe because fill
    // identity is (order_id, execution_ref): a fill we already hold is absorbed.
    if (externalFilled > internalFilled && Array.isArray(external.fills)) {
        for (const fill of external.fills) {
            await applyFill({
                orderId, executionRef: fill.executionRef, quantity: fill.quantity,
                pricePaise: fill.pricePaise, source: "reconciliation",
            });
        }
        const after = await getOrder(orderId);
        await record(order, OUTCOME.MISMATCH, external.state, externalFilled,
                     `applied ${externalFilled - internalFilled} missing filled quantity`);
        return { outcome: OUTCOME.MISMATCH, order: after };
    }

    // We believe more filled than the venue does. That cannot be repaired by
    // inventing a reversal.
    if (externalFilled < internalFilled) {
        await record(order, OUTCOME.MISMATCH, external.state, externalFilled,
                     "internal filled quantity exceeds external; manual reconciliation required");
        if (!isTerminal(order.state) && order.state !== STATES.AMBIGUOUS) {
            await markAmbiguous(orderId, "internal fill exceeds external");
        }
        return { outcome: OUTCOME.MISMATCH, order: await getOrder(orderId) };
    }

    // Quantities agree but the states disagree. The venue is the authority on
    // its own order, so adopt its state when the transition is legal. This is
    // how an AMBIGUOUS order gets resolved once truth becomes available.
    if (canTransition(order.state, external.state)) {
        const resolved = await resolveTo(orderId, external.state);
        await record(order, OUTCOME.MISMATCH, external.state, externalFilled,
                     `adopted external state ${external.state}`);
        return { outcome: OUTCOME.MISMATCH, order: resolved };
    }

    await record(order, OUTCOME.MISMATCH, external.state, externalFilled,
                 `external state ${external.state} is not reachable from ${order.state}`);
    if (!isTerminal(order.state) && order.state !== STATES.AMBIGUOUS) {
        await markAmbiguous(orderId, `unreachable external state ${external.state}`);
    }
    return { outcome: OUTCOME.MISMATCH, order: await getOrder(orderId) };
};

// Startup and periodic sweep.
export const reconcileAll = async (userId, fetchExternal) => {
    const results = [];
    for (const order of await openOrders(userId)) {
        const external = await fetchExternal(order);
        results.push({ orderId: order.id, ...(await reconcileOrder(order.id, external)) });
    }
    return results;
};

// While any order is AMBIGUOUS the book's true exposure is unknown, so new
// exposure must stop. Exits stay permitted.
export const hasUnresolvedAmbiguity = async (userId) => {
    const { rows } = await pool.query(
        "SELECT COUNT(*)::int AS n FROM orders WHERE user_id=$1 AND state='AMBIGUOUS'", [userId]);
    return rows[0].n > 0;
};

export const reconciliationsFor = async (orderId) => {
    const { rows } = await pool.query(
        "SELECT * FROM order_reconciliations WHERE order_id=$1 ORDER BY created_at", [orderId]);
    return rows;
};
