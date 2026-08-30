// Tier 4: fresh-world revalidation.
//
// A decision is formed from a snapshot. Between that snapshot and the order
// reaching the venue the model thought for seconds, the price moved, another
// fill may have landed, and the position may already be gone. Nothing checked
// any of that: the risk gate was handed the same snapshot the model used, so
// its own drift and age guards compared a value with itself and could never
// fire.
//
// This runs immediately before execution on state read at that instant. It can
// only ever make an intent smaller, later-priced, or refused. It never enlarges
// one and never creates one.
//
// It is not a replacement for the risk gate. It runs first, and the gate then
// evaluates the revalidated intent against freshly read portfolio state.

export const VERDICT = { PROCEED: "PROCEED", REPRICED: "REPRICED", REJECT: "REJECT" };

export const CODE = {
    NO_PRICE: "NO_PRICE",
    STALE_DATA: "STALE_DATA",
    DECISION_EXPIRED: "DECISION_EXPIRED",
    PRICE_DRIFT: "PRICE_DRIFT",
    POSITION_GONE: "POSITION_GONE",
    POSITION_REDUCED: "POSITION_REDUCED",
    SIDE_CONFLICT: "SIDE_CONFLICT",
};

export const DEFAULT_TOLERANCE = {
    // A thesis built on a price is void if the market has left that price. 30
    // bps is well inside the 73.55 bps round trip the thesis had to clear, so
    // a drift this size materially changes the economics it was justified by.
    maxEntryDriftBps: 30,
    // How long a judgement stays actionable. Beyond this the world it described
    // is not the world we would be trading.
    maxDecisionAgeMs: 30_000,
    // Same bound the rest of the system uses for a usable tick.
    maxDataAgeMs: 90_000,
};

const REDUCING = new Set(["EXIT", "REDUCE", "SELL"]);
export const isReducing = (action) => REDUCING.has(action);

const reject = (code, reason) => ({ verdict: VERDICT.REJECT, code, reason, intent: null });

export const driftBps = (fromPaise, toPaise) => {
    if (!Number.isFinite(fromPaise) || fromPaise <= 0) return null;
    if (!Number.isFinite(toPaise)) return null;
    return ((toPaise - fromPaise) / fromPaise) * 10_000;
};

// `observation` is what the decision was formed from; `world` is what is true
// now. Both are supplied by the caller so this function reads no clock and no
// database and stays deterministic.
export const revalidate = ({
    intent, observation, world, tolerance = DEFAULT_TOLERANCE,
}) => {
    if (!intent) return reject(CODE.NO_PRICE, "no intent supplied");
    if (!observation || !Number.isFinite(observation.pricePaise))
        return reject(CODE.NO_PRICE, "decision carries no observed price");
    if (!world || !Number.isFinite(world.nowMs))
        return reject(CODE.STALE_DATA, "no current world state supplied");

    const reducing = isReducing(intent.action);

    const age = world.nowMs - observation.atMs;
    if (Number.isFinite(observation.atMs) && age > tolerance.maxDecisionAgeMs) {
        return reject(CODE.DECISION_EXPIRED,
            `decision is ${Math.round(age / 1000)}s old; limit ${tolerance.maxDecisionAgeMs / 1000}s`);
    }

    const currentPaise = world.pricePaise;
    if (!Number.isFinite(currentPaise) || currentPaise <= 0)
        return reject(CODE.NO_PRICE, "no current price to execute against");

    const dataAge = world.priceAgeMs;
    const stale = !Number.isFinite(dataAge) || dataAge > tolerance.maxDataAgeMs;
    if (stale && !reducing) {
        return reject(CODE.STALE_DATA,
            `market data is ${Number.isFinite(dataAge) ? `${Math.round(dataAge / 1000)}s` : "of unknown"} age`);
    }

    // Position checks apply only to actions against an existing position.
    let quantity = intent.quantity;
    const notes = [];
    if (reducing) {
        const held = world.position?.quantity ?? 0;
        if (held <= 0)
            return reject(CODE.POSITION_GONE, "the position this decision was about no longer exists");
        if (quantity > held) {
            // Something else already reduced it. Sell what is actually there
            // rather than refusing to protect what remains.
            quantity = held;
            notes.push(`${CODE.POSITION_REDUCED}: sizing down to the ${held} still held`);
        }
    } else if ((world.position?.quantity ?? 0) > 0 && intent.action === "BUY") {
        // Adding to a position the decision did not know about is a different
        // trade from the one that was reasoned about.
        notes.push("position opened since the decision; exposure check applies to the combined size");
    }

    const drift = driftBps(observation.pricePaise, currentPaise);
    if (!reducing && Number.isFinite(drift) && Math.abs(drift) > tolerance.maxEntryDriftBps) {
        return reject(CODE.PRICE_DRIFT,
            `price moved ${Math.round(drift)} bps since the decision; limit ${tolerance.maxEntryDriftBps}`);
    }

    // The intent executes at the current price and remembers the price it was
    // reasoned at. These are now genuinely different values, which is what
    // makes the risk gate's own drift guard capable of firing.
    const revalidated = {
        ...intent,
        quantity,
        pricePaise: currentPaise,
        referencePricePaise: observation.pricePaise,
        createdAtMs: observation.atMs,
        observedTickSeq: observation.tickSeq ?? null,
    };

    const repriced = quantity !== intent.quantity || currentPaise !== intent.pricePaise;
    return {
        verdict: repriced ? VERDICT.REPRICED : VERDICT.PROCEED,
        code: null,
        reason: notes.length ? notes.join("; ") : null,
        driftBps: drift,
        staleExit: stale && reducing,
        intent: revalidated,
    };
};
