// The canonical order state machine.
//
// The vocabulary matches the P4/P5 Python core so research and production
// describe an order's life the same way. The transition table is the authority:
// a state change absent from it is a bug, not an edge case, and the engine
// raises rather than guessing.
//
// The rule that shapes the whole design: SUBMISSION IS NOT EXECUTION. There is
// no NEW -> FILLED edge. An order must be accepted, must become working, and
// can only fill against a market event strictly after it started working.

export const STATES = {
    NEW: "NEW",
    ACCEPTED: "ACCEPTED",
    WORKING: "WORKING",
    PARTIALLY_FILLED: "PARTIALLY_FILLED",
    FILLED: "FILLED",
    CANCELLED: "CANCELLED",
    EXPIRED: "EXPIRED",
    REJECTED: "REJECTED",
    AMBIGUOUS: "AMBIGUOUS",
};

export const TERMINAL_STATES = new Set([
    STATES.FILLED, STATES.CANCELLED, STATES.EXPIRED, STATES.REJECTED,
]);

// AMBIGUOUS is deliberately NOT terminal. An order whose outcome is unknown
// must be resolvable by reconciliation, and must keep blocking new exposure
// until it is.
export const VALID_TRANSITIONS = {
    // NEW may be cancelled or expire before acknowledgement. Without those
    // edges an order that is never acknowledged would hold its reservation
    // forever with no legal way out.
    [STATES.NEW]: new Set([
        STATES.ACCEPTED, STATES.REJECTED, STATES.CANCELLED,
        STATES.EXPIRED, STATES.AMBIGUOUS,
    ]),
    [STATES.ACCEPTED]: new Set([STATES.WORKING, STATES.CANCELLED, STATES.EXPIRED, STATES.AMBIGUOUS]),
    [STATES.WORKING]: new Set([
        STATES.PARTIALLY_FILLED, STATES.FILLED, STATES.CANCELLED,
        STATES.EXPIRED, STATES.AMBIGUOUS,
    ]),
    [STATES.PARTIALLY_FILLED]: new Set([
        STATES.PARTIALLY_FILLED, STATES.FILLED, STATES.CANCELLED,
        STATES.EXPIRED, STATES.AMBIGUOUS,
    ]),
    [STATES.FILLED]: new Set(),
    [STATES.CANCELLED]: new Set(),
    [STATES.EXPIRED]: new Set(),
    [STATES.REJECTED]: new Set(),
    // Reconciliation is the only way out of ambiguity, and it may land on any
    // state the external truth turns out to support.
    [STATES.AMBIGUOUS]: new Set([
        STATES.WORKING, STATES.PARTIALLY_FILLED, STATES.FILLED,
        STATES.CANCELLED, STATES.EXPIRED, STATES.REJECTED,
    ]),
};

export class InvalidTransition extends Error {
    constructor(from, to) {
        super(`illegal order transition ${from} -> ${to}`);
        this.from = from;
        this.to = to;
    }
}

export const isTerminal = (state) => TERMINAL_STATES.has(state);

export const canTransition = (from, to) =>
    Boolean(VALID_TRANSITIONS[from]?.has(to));

export const assertTransition = (from, to) => {
    if (!canTransition(from, to)) throw new InvalidTransition(from, to);
    return to;
};

// Which state a fill leaves the order in. Expressed once so the engine cannot
// drift from the constraint the database enforces.
export const stateAfterFill = (requested, filled) => {
    if (filled > requested) throw new Error("overfill");
    if (filled === requested) return STATES.FILLED;
    if (filled > 0) return STATES.PARTIALLY_FILLED;
    return STATES.WORKING;
};
