import { SEVERITY } from "../autonomous/events.js";

// Bounded work queue between event detection and reasoning.
//
// Events can arrive faster than an LLM can think. Without a bound, a volatile
// minute would build a backlog the system then reasons through minutes later,
// acting on state that no longer exists. That is worse than dropping work:
// it is acting on a stale view while believing it is current.
//
// Policy:
//   - COALESCE  a newer event for the same (symbol, type) supersedes the older
//   - PRIORITY  CRITICAL before WARNING before INFO
//   - BOUNDED   at capacity the lowest-priority oldest item is dropped
//   - EXPIRY    an event older than maxAgeMs is never handed out

export const DEFAULT_CAPACITY = 200;
export const DEFAULT_MAX_AGE_MS = 60_000;

const RANK = { [SEVERITY.CRITICAL]: 0, [SEVERITY.WARNING]: 1, [SEVERITY.INFO]: 2 };
const rankOf = (event) => RANK[event.severity] ?? 3;

// How much opportunity the event carries, as a percentage move. Severity alone
// cannot order this queue: every anomaly the detectors raise is CRITICAL, so
// they all tie at rank 0 and the tiebreak falls to arrival order. A 7%
// breakout then waits behind a 0.29% blip that happened to arrive first, and
// with reasoning slower than arrivals the breakout is what expires.
//
// Absent means zero, which sorts last — an event carrying no measured move has
// no claim on the reasoning budget ahead of one that does.
const strengthOf = (event) => (Number.isFinite(event.strength) ? Math.abs(event.strength) : 0);

// Highest severity, then most opportunity, then oldest. Returns negative when
// `a` should be served first.
const priorityOrder = (a, b) => {
    const byRank = rankOf(a.event) - rankOf(b.event);
    if (byRank !== 0) return byRank;
    const byStrength = strengthOf(b.event) - strengthOf(a.event);
    if (byStrength !== 0) return byStrength;
    return a.receivedAt - b.receivedAt;
};

export class EventQueue {
    constructor({ capacity = DEFAULT_CAPACITY, maxAgeMs = DEFAULT_MAX_AGE_MS,
                  clock = () => Date.now() } = {}) {
        this.capacity = capacity;
        this.maxAgeMs = maxAgeMs;
        this.clock = clock;
        this.items = new Map();          // coalesce key -> event
        this.stats = { admitted: 0, coalesced: 0, duplicates: 0, dropped: 0, expired: 0,
                       severityPreserved: 0 };
        // Events evicted or expired without being handled. The caller returns
        // them to the durable store so the condition is not lost, which is what
        // an in-memory `seen` set used to prevent forever.
        this.released = [];
    }

    static coalesceKey(event) {
        // One pending item per symbol and type: a second STOP_APPROACHING for
        // the same position replaces the first rather than queueing behind it.
        return `${event.type}:${event.symbol}:${event.thesisId ?? "none"}`;
    }

    get size() { return this.items.size; }

    offer(event, receivedAt = this.clock()) {
        const key = EventQueue.coalesceKey(event);
        const existing = this.items.get(key);
        if (existing) {
            // Coalescing must never downgrade. A later, milder observation of
            // the same condition replaces the detail but keeps the worst
            // severity seen, because that is what decides its priority.
            const kept = rankOf(existing.event) <= rankOf(event)
                ? existing.event.severity : event.severity;
            if (kept !== event.severity) this.stats.severityPreserved += 1;
            // Strength is kept at its high-water mark for the same reason
            // severity is: a later, milder look at one condition must not
            // demote what was already seen.
            const strength = Math.max(strengthOf(existing.event), strengthOf(event));
            this.items.set(key, {
                event: { ...event, severity: kept, strength }, receivedAt });
            this.stats.coalesced += 1;
            return "coalesced";
        }

        if (this.items.size >= this.capacity) {
            const victim = this.lowestPriorityOldest();
            // Never drop something more important than what is arriving.
            if (victim && rankOf(victim.event) >= rankOf(event)) {
                this.items.delete(EventQueue.coalesceKey(victim.event));
                this.released.push(victim.event);
                this.stats.dropped += 1;
            } else {
                this.released.push(event);
                this.stats.dropped += 1;
                return "rejected";
            }
        }

        this.items.set(key, { event, receivedAt });
        this.stats.admitted += 1;
        return "admitted";
    }

    // The one to drop when the queue is full: lowest severity, then least
    // opportunity, then oldest.
    lowestPriorityOldest() {
        let worst = null;
        for (const item of this.items.values()) {
            if (!worst) { worst = item; continue; }
            if (priorityOrder(item, worst) > 0) worst = item;
        }
        return worst;
    }

    // Highest priority, oldest first within a priority. Expired items are
    // discarded rather than returned: reasoning about a minute-old tick and
    // then executing on it is exactly the failure this queue prevents.
    take() {
        const now = this.clock();
        let best = null;
        for (const [key, item] of this.items) {
            if (now - item.receivedAt > this.maxAgeMs) {
                this.items.delete(key);
                // Released, not discarded. The durable row stays PENDING so the
                // condition is offered again rather than vanishing.
                this.released.push(item.event);
                this.stats.expired += 1;
                continue;
            }
            if (!best) { best = { key, item }; continue; }
            if (priorityOrder(item, best.item) < 0) best = { key, item };
        }
        if (!best) return null;
        this.items.delete(best.key);
        return best.item.event;
    }

    drain(limit = Infinity) {
        const out = [];
        while (out.length < limit) {
            const next = this.take();
            if (!next) break;
            out.push(next);
        }
        return out;
    }

    // Events the queue could not hold. The caller drains this and returns them
    // to PENDING in the durable store.
    drainReleased() {
        const out = this.released;
        this.released = [];
        return out;
    }

    health() {
        return { depth: this.items.size, capacity: this.capacity,
                 released: this.released.length, ...this.stats };
    }
}
