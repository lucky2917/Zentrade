// How a reassessment becomes an order intent.
//
// This module used to hold a second reasoning loop as well. The orchestrator's
// reasoningCycle superseded it and nothing called it, so it was two subtly
// different implementations of the same decision path with one of them wired
// up. It has been removed: a duplicate that nobody runs is a duplicate that
// somebody eventually wires up by mistake.
//
// Pure. No clock, no socket, no database.

export const ACTION_TO_INTENT = {
    EXIT: "SELL",
    REDUCE: "SELL",
    ADD: "BUY",
    HOLD: null,
};

// A reassessment that yields HOLD produces no order. Anything else becomes an
// intent that the risk gate must approve before it can reach execution.
export const intentFrom = (decision, position) => {
    const side = ACTION_TO_INTENT[decision.action];
    if (!side) return null;

    const quantity = decision.action === "REDUCE"
        ? Math.max(1, Math.floor(position.quantity / 2))
        : position.quantity;

    return {
        action: decision.action,
        side,
        symbol: position.symbol,
        quantity: decision.action === "ADD" ? Math.max(1, position.quantity) : quantity,
        pricePaise: position.currentPricePaise,
        referencePricePaise: position.currentPricePaise,
        correlationId: position.correlationId,
        clientOrderId: `${position.correlationId}:${decision.action}:${position.symbol}`,
    };
};
