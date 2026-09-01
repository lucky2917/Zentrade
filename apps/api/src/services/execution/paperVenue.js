import { STATES } from "./states.js";

// A deterministic paper venue.
//
// Simulates an exchange badly on purpose: real venues acknowledge late, fill
// in pieces, reject, expire, repeat acknowledgements, and occasionally go
// silent. A simulator that always fills cleanly proves nothing, which P4
// already learned once.
//
// It is driven by an explicit script rather than randomness, so a soak run is
// reproducible and a failure is debuggable.
//
// STATE VOCABULARY: the Phase 1 transition table is authoritative. The venue
// concepts map onto it as:
//     submitted       -> NEW          (created, not yet acknowledged)
//     acknowledged    -> ACCEPTED     (venue has it)
//     working         -> WORKING      (resting on the book)
//     cancel requested-> (no state; a cancel either lands or the order fills)
// No new states were introduced and no illegal transition was added.

export const VENUE_BEHAVIOUR = {
    IMMEDIATE_FILL: "IMMEDIATE_FILL",
    PARTIAL_THEN_COMPLETE: "PARTIAL_THEN_COMPLETE",
    PARTIAL_THEN_STALL: "PARTIAL_THEN_STALL",
    DELAYED_FILL: "DELAYED_FILL",
    REJECT: "REJECT",
    CANCEL: "CANCEL",
    EXPIRE: "EXPIRE",
    SILENT: "SILENT",
    DUPLICATE_ACK: "DUPLICATE_ACK",
    DUPLICATE_FILL: "DUPLICATE_FILL",
};

// States a resting order can be picked back up from. AMBIGUOUS is excluded on
// purpose: reconciliation owns it.
const ADOPTABLE = new Set([
    STATES.NEW, STATES.ACCEPTED, STATES.WORKING, STATES.PARTIALLY_FILLED,
]);

export class PaperVenue {
    // `script` maps a symbol to the behaviour it should exhibit. Anything not
    // scripted uses `defaultBehaviour`.
    constructor({ engine, script = {}, defaultBehaviour = VENUE_BEHAVIOUR.IMMEDIATE_FILL,
                  clock = () => new Date(), logger = null } = {}) {
        this.engine = engine;
        this.script = script;
        this.defaultBehaviour = defaultBehaviour;
        this.clock = clock;
        this.logger = logger;
        this.pending = new Map();
        this.stats = {
            submitted: 0, acknowledged: 0, filled: 0, partiallyFilled: 0,
            rejected: 0, cancelled: 0, expired: 0, silent: 0,
            duplicateAcks: 0, duplicateFills: 0,
        };
    }

    behaviourFor(symbol) {
        return this.script[symbol] ?? this.defaultBehaviour;
    }

    // Accepts an approved intent and drives it through the Phase 1 engine.
    // The venue never touches cash or positions directly: everything goes
    // through applyFill so accounting stays in one place.
    async submit(intent) {
        const { order, duplicate } = await this.engine.submitOrder({
            userId: intent.userId, symbol: intent.symbol, side: intent.side,
            quantity: intent.quantity, pricePaise: intent.pricePaise,
            mode: intent.mode ?? "INTRADAY",
            clientOrderId: intent.clientOrderId, correlationId: intent.correlationId ?? null,
            decisionId: intent.decisionId ?? null, thesisId: intent.thesisId ?? null,
            expiresAt: intent.expiresAt ?? null,
        });

        if (duplicate) return { order, duplicate: true, behaviour: null };
        this.stats.submitted += 1;

        const behaviour = this.behaviourFor(intent.symbol);

        if (behaviour === VENUE_BEHAVIOUR.REJECT) {
            this.stats.rejected += 1;
            const rejected = await this.engine.rejectOrder(order.id, "venue rejected the order");
            return { order: rejected, duplicate: false, behaviour };
        }

        if (behaviour === VENUE_BEHAVIOUR.SILENT) {
            // The venue never answers. The order stays NEW and reconciliation
            // is the only thing that can resolve it.
            this.stats.silent += 1;
            this.pending.set(order.id, { intent, behaviour, filled: 0 });
            return { order, duplicate: false, behaviour };
        }

        let current = await this.engine.acceptOrder(order.id);
        this.stats.acknowledged += 1;

        if (behaviour === VENUE_BEHAVIOUR.DUPLICATE_ACK) {
            // A repeated acknowledgement must be absorbed, not applied twice.
            try {
                await this.engine.acceptOrder(order.id);
            } catch {
                this.stats.duplicateAcks += 1;
            }
        }

        current = await this.engine.workOrder(order.id);
        this.pending.set(order.id, { intent, behaviour, filled: 0 });

        if (behaviour === VENUE_BEHAVIOUR.DELAYED_FILL) return { order: current, duplicate: false, behaviour };

        return { order: await this.advance(order.id), duplicate: false, behaviour };
    }

    // Resting orders left behind by a process that went away.
    //
    // The pending map is memory. A restart built an empty one, so an order the
    // database still showed as ACCEPTED or WORKING was never advanced again: it
    // could not fill, the runtime sets no expiry so it could not expire, and
    // reconciliation compared it against this venue's reading of the same row
    // and reported MATCHED. It rested forever holding its cash reservation.
    //
    // AMBIGUOUS orders are deliberately not adopted. Their outcome is unknown,
    // and filling one would be inventing the answer reconciliation exists to
    // establish.
    async adopt(orders = []) {
        let adopted = 0;
        for (const order of orders) {
            if (this.pending.has(order.id)) continue;
            if (!ADOPTABLE.has(order.state)) continue;
            this.pending.set(order.id, {
                intent: null, behaviour: this.behaviourFor(order.symbol), filled: 0,
                recovered: true,
            });
            adopted += 1;
        }
        if (adopted) {
            this.logger?.info?.("PaperVenue", "adopted resting orders after a restart",
                                { count: adopted });
        }
        return adopted;
    }

    // One venue tick for a resting order. Called by the scheduler so a delayed
    // fill lands on a later cycle rather than instantly.
    async advance(orderId) {
        const entry = this.pending.get(orderId);
        if (!entry) return this.engine.getOrder(orderId);

        let order = await this.engine.getOrder(orderId);
        if (!order) { this.pending.delete(orderId); return order; }

        // An adopted order may not have reached the book yet. Walk it forward
        // the same way submit() would have, so recovery drives one order
        // lifecycle rather than a second, parallel one.
        if (order.state === STATES.NEW) {
            await this.engine.acceptOrder(orderId);
            this.stats.acknowledged += 1;
            order = await this.engine.getOrder(orderId);
        }
        if (order.state === STATES.ACCEPTED) {
            order = await this.engine.workOrder(orderId);
        }

        if (!["WORKING", "PARTIALLY_FILLED"].includes(order.state)) {
            this.pending.delete(orderId);
            return order;
        }

        const total = Number(order.quantity);
        const already = Number(order.filled_quantity);
        const remaining = total - already;
        const price = Number(order.reference_price_paise ?? order.price_paise);

        switch (entry.behaviour) {
            case VENUE_BEHAVIOUR.CANCEL: {
                this.stats.cancelled += 1;
                this.pending.delete(orderId);
                return this.engine.cancelOrder(orderId);
            }
            case VENUE_BEHAVIOUR.EXPIRE: {
                this.stats.expired += 1;
                this.pending.delete(orderId);
                return this.engine.expireOrder(orderId);
            }
            case VENUE_BEHAVIOUR.PARTIAL_THEN_STALL: {
                if (already > 0) return order;            // stalls forever
                const slice = Math.max(1, Math.floor(total / 3));
                this.stats.partiallyFilled += 1;
                const result = await this.engine.applyFill({
                    orderId, executionRef: `${orderId}-p1`, quantity: slice, pricePaise: price });
                return result.order;
            }
            case VENUE_BEHAVIOUR.PARTIAL_THEN_COMPLETE: {
                const slice = already === 0 ? Math.max(1, Math.floor(total / 3)) : remaining;
                if (already === 0) this.stats.partiallyFilled += 1; else this.stats.filled += 1;
                const result = await this.engine.applyFill({
                    orderId, executionRef: `${orderId}-p${already === 0 ? 1 : 2}`,
                    quantity: slice, pricePaise: price });
                if (result.order.state === STATES.FILLED) this.pending.delete(orderId);
                return result.order;
            }
            case VENUE_BEHAVIOUR.DUPLICATE_FILL: {
                const ref = `${orderId}-dup`;
                await this.engine.applyFill({ orderId, executionRef: ref, quantity: remaining, pricePaise: price });
                const second = await this.engine.applyFill({
                    orderId, executionRef: ref, quantity: remaining, pricePaise: price });
                if (second.duplicate) this.stats.duplicateFills += 1;
                this.pending.delete(orderId);
                this.stats.filled += 1;
                return second.order;
            }
            default: {
                this.stats.filled += 1;
                const result = await this.engine.applyFill({
                    orderId, executionRef: `${orderId}-full`, quantity: remaining, pricePaise: price });
                this.pending.delete(orderId);
                return result.order;
            }
        }
    }

    // Scheduler job: advance every resting order once.
    async tick() {
        const advanced = [];
        for (const orderId of [...this.pending.keys()]) {
            advanced.push(await this.advance(orderId));
        }
        return advanced;
    }

    // What the venue believes, for reconciliation. A silent order returns null,
    // which is exactly the case that must produce AMBIGUOUS rather than a guess.
    //
    // For anything else this used to read the order's own database row back and
    // hand it over as "external truth". That is circular, and on an AMBIGUOUS
    // order it deadlocks: the row says AMBIGUOUS, the answer says AMBIGUOUS,
    // reconciliation records MATCHED and "states agree", and the order can
    // never leave the state. Observed live — a TCS BUY sat AMBIGUOUS from 06:27
    // holding Rs 99,982 of reserved cash, reconciled every minute for hours,
    // and because unresolved ambiguity blocks new exposure it halted the whole
    // book.
    //
    // The paper venue IS the exchange here, so what it knows is what happened.
    // If it is no longer tracking an order, the fills are the record: any that
    // exist are the truth, and none existing means the venue never worked it.
    // That is not a guess about an outside system, it is this simulator
    // reporting its own books.
    async externalStateOf(order) {
        const entry = this.pending.get(order.id);
        if (entry?.behaviour === VENUE_BEHAVIOUR.SILENT) return null;

        const known = await this.engine.getOrder(order.id);
        if (!known) return null;

        // Still in hand: the row and the venue are the same thing.
        if (entry) {
            return { state: known.state, filledQuantity: Number(known.filled_quantity), fills: [] };
        }

        // Not in hand. Answer from the fills, which is the only independent
        // record of what this venue actually did.
        const fills = await this.engine.fillsFor(order.id);
        const filledQuantity = fills.reduce((n, f) => n + Number(f.quantity), 0);
        if (filledQuantity === 0) {
            return { state: STATES.CANCELLED, filledQuantity: 0, fills: [] };
        }
        return {
            state: filledQuantity >= Number(known.quantity) ? STATES.FILLED
                                                            : STATES.PARTIALLY_FILLED,
            filledQuantity,
            fills: [],
        };
    }

    health() {
        return { ...this.stats, resting: this.pending.size };
    }
}
