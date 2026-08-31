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
    // Continuous material-change detection. These are not pre-commitments, so
    // they do not trigger a protective action: they wake the trader. They live
    // on the tick because they are observable on the tick, and a 15-second
    // poll cannot see a move that happens and reverses between samples.
    STOP_APPROACH: "STOP_APPROACH",
    TARGET_APPROACH: "TARGET_APPROACH",
    PRICE_JUMP: "PRICE_JUMP",
    VWAP_DEVIATION: "VWAP_DEVIATION",
    VOLUME_SPIKE: "VOLUME_SPIKE",
};

// Only a crossing of a pre-committed level authorises a protective action. The
// rest are attention signals.
export const PROTECTIVE = new Set([CROSSING.STOP, CROSSING.INVALIDATION]);
export const isProtective = (kind) => PROTECTIVE.has(kind);

// Defaults are deliberately off. A watch is created explicitly by the caller
// that knows the position, so adding this detector changed no existing
// behaviour and no existing fixture.
export const DEFAULT_WATCH = {
    approachFraction: 0.25,   // within 25% of the entry-to-level span
    jumpPercent: 2.0,         // absolute move over the velocity window
    velocityWindowMs: 60_000,
    vwapDeviation: 0.02,      // 2% from session VWAP
    // Both are pushed in by the bar path. The intelligence layer owns what
    // "typical volume" and "a spike" mean; duplicating either number here
    // would let the two definitions drift apart.
    volumeBaseline: null,
    volumeSpikeRatio: null,
};

// How long a watched symbol may stay silent before the lane reports that it
// has gone blind on it. Well inside the 90 s the position monitor uses, because
// the point of the sweep is to find it sooner.
export const DEFAULT_STALE_AFTER_MS = 30_000;

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
        this.watches = new Map();   // symbol -> continuous detection config
        // Symbols already reported stale. Absence of ticks persists, so the
        // report has to be edge triggered like everything else here.
        this.staleLatched = new Set();
        this.stats = { ticks: 0, crossings: 0, armed: 0, disarmed: 0, suppressed: 0, rearmed: 0,
                       signals: 0, stale: 0, recovered: 0 };
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
        this.watches.delete(symbol);
        this.staleLatched.delete(symbol);
        if (this.armed.delete(symbol)) { this.stats.disarmed += 1; return true; }
        return false;
    }

    // Re-open every latched level on every armed symbol.
    //
    // Used when protection changes hands: a level that broke while another
    // detector was authoritative was seen here and deliberately not acted on,
    // and its latch would otherwise stop this lane ever firing it.
    rearmAll() {
        let reopened = 0;
        for (const commitment of this.armed.values()) {
            if (commitment.fired.size) { reopened += commitment.fired.size; }
            commitment.fired.clear();
        }
        for (const watch of this.watches.values()) watch.fired.clear();
        if (reopened) this.stats.rearmed += reopened;
        return reopened;
    }

    // Clear one latch so the level fires again on the next tick.
    //
    // The latch is set when the crossing is DETECTED, which is before anything
    // has acted on it. That is right for an edge trigger and wrong for a
    // handler that failed: a protective exit that could not be submitted must
    // be attempted again, or one transient error silently disarms the stop for
    // the rest of the session while the position stays open.
    //
    // Only the handler may call this, and only when it did not act.
    rearm(symbol, kind) {
        const commitment = this.armed.get(symbol);
        const watch = this.watches.get(symbol);
        let cleared = false;
        if (commitment?.fired.delete(kind)) cleared = true;
        if (watch?.fired.delete(kind)) cleared = true;
        if (cleared) this.stats.rearmed += 1;
        return cleared;
    }

    // Continuous detection for one symbol. `entryPaise` enables the approach
    // bands; `vwapPaise` is bar-scale and pushed in as it is recomputed.
    watch(symbol, config = {}) {
        if (!symbol) return false;
        const existing = this.watches.get(symbol);
        this.watches.set(symbol, {
            ...DEFAULT_WATCH,
            ...(existing ?? {}),
            ...config,
            fired: existing?.fired ?? new Set(),
            history: existing?.history ?? [],
            // The instant silence is measured from when no tick has arrived
            // since. Without it a symbol the feed never delivers has nothing to
            // measure against and looks healthy forever.
            silenceFrom: existing?.silenceFrom ?? this.clock(),
        });
        return true;
    }

    unwatch(symbol) {
        this.staleLatched.delete(symbol);
        return this.watches.delete(symbol);
    }
    isWatched(symbol) { return this.watches.has(symbol); }

    // The bar path owns VWAP; the tick path compares against it. Updating the
    // value clears the deviation latch, because a new VWAP is a new question.
    updateVwap(symbol, vwapPaise) {
        const watch = this.watches.get(symbol);
        if (!watch) return false;
        watch.vwapPaise = Number.isFinite(vwapPaise) ? vwapPaise : null;
        watch.fired.delete(CROSSING.VWAP_DEVIATION);
        return true;
    }

    // Typical volume for one completed bar, and the multiple of it that counts
    // as a spike. Both come from the intelligence layer's own baseline, so the
    // tick path and the bar path judge a spike by the same rule.
    updateVolumeBaseline(symbol, { baseline, ratio } = {}) {
        const watch = this.watches.get(symbol);
        if (!watch) return false;
        watch.volumeBaseline = Number.isFinite(baseline) && baseline > 0 ? baseline : null;
        watch.volumeSpikeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : null;
        return true;
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
    onTick({ symbol, pricePaise, at = this.clock(), cumulativeVolume = null }) {
        if (!Number.isFinite(pricePaise) || pricePaise <= 0) return [];
        this.stats.ticks += 1;
        this.observe(symbol, pricePaise, at);
        // A tick is the only proof that the feed for this symbol is alive.
        if (this.staleLatched.delete(symbol)) this.stats.recovered += 1;

        const commitment = this.armed.get(symbol);
        // A symbol with no pre-commitment can still be materially changing, so
        // detection continues without it.
        if (!commitment) {
            const signals = this.detectSignals(symbol, pricePaise, at, null, cumulativeVolume);
            if (signals.length) {
                this.stats.crossings += signals.length;
                this.dispatch(signals, symbol);
            }
            return signals;
        }

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

        crossings.push(...this.detectSignals(symbol, pricePaise, at, commitment,
                                             cumulativeVolume));

        if (crossings.length) {
            this.stats.crossings += crossings.length;
            // Fire and forget. The tick loop does not wait on the protective
            // order; blocking here would make every other symbol late.
            this.dispatch(crossings, symbol);
        }
        return crossings;
    }

    // Fire and forget. The tick loop never waits on a handler; blocking here
    // would make every other symbol late, which is the failure this whole lane
    // exists to prevent.
    dispatch(crossings, symbol) {
        if (!this.onCrossing) return;
        for (const crossing of crossings) {
            try {
                const result = this.onCrossing(crossing);
                if (result && typeof result.catch === "function") {
                    result.catch((err) => this.logger?.error?.(
                        "ReflexLane", "crossing handler failed",
                        { error: err.message, symbol, kind: crossing.kind }));
                }
            } catch (err) {
                this.logger?.error?.("ReflexLane", "crossing dispatch threw",
                                     { error: err.message, symbol });
            }
        }
    }

    // Continuous material-change detection, evaluated on every tick for any
    // symbol with a watch. Arithmetic only: no model, no I/O, no allocation
    // beyond the events actually emitted.
    //
    // Edge triggered like the protective levels, so a condition that persists
    // produces one signal rather than one per tick for the rest of the session.
    detectSignals(symbol, pricePaise, at, commitment, cumulativeVolume = null) {
        const watch = this.watches.get(symbol);
        if (!watch) return [];

        const signals = [];
        const raise = (kind, levelPaise, reason) => {
            if (watch.fired.has(kind)) { this.stats.suppressed += 1; return; }
            watch.fired.add(kind);
            this.stats.signals += 1;
            signals.push({
                kind, symbol, pricePaise, levelPaise, at, reason,
                protective: false,
                thesisId: commitment?.thesisId ?? watch.thesisId ?? null,
                direction: commitment?.direction ?? watch.direction ?? DIRECTION.LONG,
                quantity: commitment?.quantity ?? 0,
                correlationId: commitment?.correlationId ?? watch.correlationId ?? null,
            });
        };

        // --- approach bands ---------------------------------------------
        // Distance to a level as a fraction of the entry-to-level span. The
        // 15-second monitor computed exactly this; it just could not see a
        // move that entered and left the band between two samples.
        const entry = watch.entryPaise;
        if (Number.isFinite(entry) && commitment) {
            const band = (levelPaise, kind) => {
                if (!Number.isFinite(levelPaise)) return;
                const span = levelPaise - entry;
                if (span === 0) return;
                const remaining = (levelPaise - pricePaise) / span;
                if (remaining > 0 && remaining <= watch.approachFraction) {
                    raise(kind, levelPaise,
                        `within ${Math.round(remaining * 100)}% of the level at ${levelPaise}`);
                }
            };
            band(commitment.stopPaise, CROSSING.STOP_APPROACH);
            band(commitment.targetPaise, CROSSING.TARGET_APPROACH);
        }

        // --- price velocity ---------------------------------------------
        // A move measured over a real window rather than between two poll
        // samples, so a spike that reverses inside the window is still seen.
        watch.history.push({ at, pricePaise });
        const cutoff = at - watch.velocityWindowMs;
        while (watch.history.length > 1 && watch.history[0].at < cutoff) watch.history.shift();
        if (watch.history.length > 1) {
            const oldest = watch.history[0].pricePaise;
            if (oldest > 0) {
                const movePercent = ((pricePaise - oldest) / oldest) * 100;
                if (Math.abs(movePercent) >= watch.jumpPercent) {
                    raise(CROSSING.PRICE_JUMP, oldest,
                        `moved ${movePercent.toFixed(2)}% within ${Math.round(watch.velocityWindowMs / 1000)}s`);
                }
            }
        }

        // --- vwap deviation ----------------------------------------------
        if (Number.isFinite(watch.vwapPaise) && watch.vwapPaise > 0) {
            const deviation = (pricePaise - watch.vwapPaise) / watch.vwapPaise;
            if (Math.abs(deviation) >= watch.vwapDeviation) {
                raise(CROSSING.VWAP_DEVIATION, watch.vwapPaise,
                    `${(deviation * 100).toFixed(2)}% from session VWAP`);
            }
        }

        // --- volume ------------------------------------------------------
        // The feed reports volume cumulatively for the session, so the volume
        // of the minute in progress is the delta from its first tick. The test
        // is deliberately one-sided: it asks whether an incomplete minute has
        // ALREADY exceeded several typical full minutes. That can only report
        // a spike late, never early on a projection from two seconds of data.
        if (Number.isFinite(cumulativeVolume)
            && Number.isFinite(watch.volumeBaseline) && Number.isFinite(watch.volumeSpikeRatio)) {
            const minute = Math.floor(at / 60_000);
            if (watch.volumeMinute !== minute) {
                watch.volumeMinute = minute;
                watch.volumeAnchor = cumulativeVolume;
                // A new minute is a new question, so the answer is not latched
                // from the previous one.
                watch.fired.delete(CROSSING.VOLUME_SPIKE);
            }
            // A reconnect or a session rollover can restart the counter. Re-anchor
            // rather than reporting the difference as negative volume.
            if (cumulativeVolume < watch.volumeAnchor) watch.volumeAnchor = cumulativeVolume;

            const soFar = cumulativeVolume - watch.volumeAnchor;
            const threshold = watch.volumeBaseline * watch.volumeSpikeRatio;
            if (soFar >= threshold) {
                raise(CROSSING.VOLUME_SPIKE, Math.round(threshold),
                    `${(soFar / watch.volumeBaseline).toFixed(1)}x typical minute volume`);
            }
        }

        return signals;
    }

    // Absence of ticks cannot be detected by a tick. A fast supervisory sweep
    // asks the question instead, which is the one thing here that legitimately
    // remains timer driven.
    staleSymbols(nowMs, staleAfterMs = DEFAULT_STALE_AFTER_MS) {
        const stale = [];
        for (const [symbol, watch] of this.watches) {
            const state = this.state.get(symbol);
            // The later of the last tick and the last resumption. A tick before
            // a resumption says nothing about whether the feed is alive now.
            const since = Math.max(state?.at ?? Number.NEGATIVE_INFINITY,
                                   watch.silenceFrom ?? Number.NEGATIVE_INFINITY);
            if (!Number.isFinite(since)) continue;
            const age = nowMs - since;
            if (age <= staleAfterMs) continue;
            stale.push({
                symbol, ageMs: age,
                lastPaise: state ? state.last : null,
                ticked: Boolean(state) && state.at >= (watch.silenceFrom ?? 0),
                // An armed symbol going quiet means protection is blind, which
                // is a different severity from a watched symbol going quiet.
                armed: this.armed.has(symbol),
            });
        }
        return stale;
    }

    // Start measuring silence again from now, for every watched symbol.
    //
    // The sweep only runs while the market is open, so it begins each session
    // having watched nothing. Without this, every position armed during boot
    // has been silent for as long as the process has been up, and the first
    // sweep of the day would report the whole book blind.
    resetSilence(nowMs) {
        for (const watch of this.watches.values()) watch.silenceFrom = nowMs;
        this.staleLatched.clear();
        return this.watches.size;
    }

    // Edge triggered. Silence persists, so reporting it every sweep would
    // produce one event per second for as long as the feed stayed down.
    newlyStale(nowMs, staleAfterMs = DEFAULT_STALE_AFTER_MS) {
        const fresh = [];
        for (const entry of this.staleSymbols(nowMs, staleAfterMs)) {
            if (this.staleLatched.has(entry.symbol)) continue;
            this.staleLatched.add(entry.symbol);
            this.stats.stale += 1;
            fresh.push(entry);
        }
        return fresh;
    }

    health() {
        return { ...this.stats, armedSymbols: this.armed.size,
                 watchedSymbols: this.watches.size, staleSymbols: this.staleLatched.size,
                 trackedSymbols: this.state.size };
    }
}
