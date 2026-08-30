// Tier 0: the reflex lane.
//
// A thesis is a pre-commitment. It named its stop, its target and the price
// that would prove it wrong, and the risk gate already authorised the position
// those levels belong to. When a tick crosses one of them there is no judgement
// left to make, so there is nothing for a language model to decide.
//
// Before this, a stop breach was noticed by a 15-second poll, queued, and then
// gated behind two sequential model calls: roughly 35 seconds from the level
// being lost to an order existing. Reasoning still happens — afterwards, to
// decide what the crossing means, not whether to protect.
//
// Everything here is in memory and synchronous. The tick loop must never wait
// on a database, a network call, or a lock.

export const CROSSING = {
    STOP: "STOP",
    TARGET: "TARGET",
    INVALIDATION: "INVALIDATION",
};

export const DIRECTION = { LONG: "LONG", SHORT: "SHORT" };

// A long is stopped below and targets above; a short is the mirror. Levels are
// tested against the tick itself, not against a bar close, because a bar close
// is up to a minute after the fact.
const breached = (kind, direction, pricePaise, levelPaise) => {
    if (!Number.isFinite(levelPaise)) return false;
    const long = direction !== DIRECTION.SHORT;
    if (kind === CROSSING.TARGET) return long ? pricePaise >= levelPaise : pricePaise <= levelPaise;
    return long ? pricePaise <= levelPaise : pricePaise >= levelPaise;
};

export class ReflexLane {
    constructor({ clock = () => Date.now(), logger = null, onCrossing = null } = {}) {
        this.clock = clock;
        this.logger = logger;
        this.onCrossing = onCrossing;
        this.armed = new Map();     // symbol -> commitment
        this.state = new Map();     // symbol -> observed extremes
        this.stats = { ticks: 0, crossings: 0, armed: 0, disarmed: 0, suppressed: 0 };
    }

    // Levels recorded at entry. Re-arming the same symbol replaces the previous
    // commitment, which is what a revised thesis should do.
    arm(symbol, commitment) {
        if (!symbol || !commitment) return false;
        const { thesisId = null, direction = DIRECTION.LONG,
                stopPaise = null, targetPaise = null,
                invalidationPaise = null, quantity = 0, correlationId = null } = commitment;
        if (!Number.isFinite(stopPaise) && !Number.isFinite(targetPaise)
            && !Number.isFinite(invalidationPaise)) return false;
        this.armed.set(symbol, {
            thesisId, direction, stopPaise, targetPaise, invalidationPaise,
            quantity, correlationId, armedAt: this.clock(), fired: new Set(),
        });
        this.stats.armed += 1;
        return true;
    }

    disarm(symbol) {
        if (this.armed.delete(symbol)) { this.stats.disarmed += 1; return true; }
        return false;
    }

    isArmed(symbol) { return this.armed.has(symbol); }
    commitmentFor(symbol) { return this.armed.get(symbol) ?? null; }

    // Running extremes between evaluations. A move that spikes through a level
    // and retraces inside one poll interval used to be invisible; the reflex
    // sees the tick that crossed, and the monitor can still see the range.
    observe(symbol, pricePaise, at) {
        const prior = this.state.get(symbol);
        const next = prior
            ? { last: pricePaise, high: Math.max(prior.high, pricePaise),
                low: Math.min(prior.low, pricePaise), seq: prior.seq + 1, at }
            : { last: pricePaise, high: pricePaise, low: pricePaise, seq: 1, at };
        this.state.set(symbol, next);
        return next;
    }

    // What the symbol did since the last time anyone asked, then reset the
    // window. This is what the supervisory monitor should reason over.
    takeRange(symbol) {
        const current = this.state.get(symbol);
        if (!current) return null;
        this.state.set(symbol, { ...current, high: current.last, low: current.last, seq: 0 });
        return current;
    }

    snapshot(symbol) { return this.state.get(symbol) ?? null; }

    // The hot path. Synchronous, allocation-light, and it never awaits.
    // Returns the crossings this tick caused; the caller dispatches them.
    onTick({ symbol, pricePaise, at = this.clock() }) {
        if (!Number.isFinite(pricePaise) || pricePaise <= 0) return [];
        this.stats.ticks += 1;
        this.observe(symbol, pricePaise, at);

        const commitment = this.armed.get(symbol);
        if (!commitment) return [];

        const crossings = [];
        const test = (kind, levelPaise) => {
            if (!breached(kind, commitment.direction, pricePaise, levelPaise)) return;
            // Edge-triggered. A position sitting past its stop produces one
            // crossing, not one per tick for the rest of the session.
            if (commitment.fired.has(kind)) { this.stats.suppressed += 1; return; }
            commitment.fired.add(kind);
            crossings.push({
                kind, symbol, pricePaise, levelPaise, at,
                thesisId: commitment.thesisId,
                direction: commitment.direction,
                quantity: commitment.quantity,
                correlationId: commitment.correlationId,
            });
        };

        test(CROSSING.STOP, commitment.stopPaise);
        test(CROSSING.INVALIDATION, commitment.invalidationPaise);
        test(CROSSING.TARGET, commitment.targetPaise);

        if (crossings.length) {
            this.stats.crossings += crossings.length;
            // Fire and forget. The tick loop does not wait on the protective
            // order; blocking here would make every other symbol late.
            if (this.onCrossing) {
                for (const crossing of crossings) {
                    try {
                        const result = this.onCrossing(crossing);
                        if (result && typeof result.catch === "function") {
                            result.catch((err) => this.logger?.error?.(
                                "ReflexLane", "protective action failed",
                                { error: err.message, symbol, kind: crossing.kind }));
                        }
                    } catch (err) {
                        this.logger?.error?.("ReflexLane", "protective dispatch threw",
                                             { error: err.message, symbol });
                    }
                }
            }
        }
        return crossings;
    }

    health() {
        return { ...this.stats, armedSymbols: this.armed.size, trackedSymbols: this.state.size };
    }
}
