import { sessionDateOf } from "./events.js";

// Single-flight per symbol, and idempotency keyed on the intent rather than on
// the decision that produced it.
//
// Two scheduler jobs could reach the entry path: the 60s candidate scan and the
// 5s reasoning cycle handling an anomaly. The scheduler stops a job overlapping
// itself, never two different jobs, and there was no per-symbol lock. Each path
// minted its own correlation id, so each derived a different client order id,
// so both the engine's idempotency key and the risk gate's duplicate check saw
// two unrelated orders for one symbol.
//
// The lock stops the concurrency. The key stops the duplicate even if a lock is
// ever bypassed, because two decisions to do the same thing to the same symbol
// in the same state now produce the same identity.

export class SymbolGate {
    constructor({ clock = () => Date.now(), staleAfterMs = 120_000, logger = null } = {}) {
        this.held = new Map();          // symbol -> { at, holder }
        this.clock = clock;
        this.staleAfterMs = staleAfterMs;
        this.logger = logger;
        this.stats = { acquired: 0, rejected: 0, forced: 0 };
    }

    // Returns a release function, or null when the symbol is already being
    // worked on. Never blocks: the caller skips this cycle instead of queueing,
    // because by the time a lock would free the observation is stale anyway.
    acquire(symbol, holder = "unknown") {
        const now = this.clock();
        const existing = this.held.get(symbol);
        if (existing) {
            // A lock older than the bound means the holder died mid-flight.
            // Reclaiming it is safer than deadlocking the symbol for the session.
            if (now - existing.at <= this.staleAfterMs) {
                this.stats.rejected += 1;
                return null;
            }
            this.stats.forced += 1;
            this.logger?.warn?.("SymbolGate", "reclaimed a stale lock",
                                { symbol, heldBy: existing.holder, ageMs: now - existing.at });
        }
        this.held.set(symbol, { at: now, holder });
        this.stats.acquired += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const current = this.held.get(symbol);
            if (current && current.at === now) this.held.delete(symbol);
        };
    }

    isHeld(symbol) { return this.held.has(symbol); }
    health() { return { held: this.held.size, ...this.stats }; }
}

// Identity of an entry: this symbol, this side, this session, this position
// epoch. Two concurrent decisions see the same epoch and therefore collide at
// the engine; a genuine re-entry after an exit sees a higher epoch and is
// allowed.
export const entryIntentKey = ({ symbol, action, at, epoch = 0 }) =>
    [sessionDateOf(at), symbol, action, `e${epoch}`].join(":");

// Identity of an action against a position: the thesis it concerns. One thesis
// gets one exit however many events argue for it.
export const positionIntentKey = ({ thesisId, action, symbol, at }) =>
    thesisId ? [thesisId, action].join(":")
             : [sessionDateOf(at), symbol, action, "nothesis"].join(":");
