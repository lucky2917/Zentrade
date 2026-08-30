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
            this.items.set(key, { event: { ...event, severity: kept }, receivedAt });
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

    lowestPriorityOldest() {
        let worst = null;
        for (const item of this.items.values()) {
            if (!worst) { worst = item; continue; }
            const byRank = rankOf(item.event) - rankOf(worst.event);
            if (byRank > 0 || (byRank === 0 && item.receivedAt < worst.receivedAt)) worst = item;
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
            const byRank = rankOf(item.event) - rankOf(best.item.event);
            if (byRank < 0 || (byRank === 0 && item.receivedAt < best.item.receivedAt)) {
                best = { key, item };
            }
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
