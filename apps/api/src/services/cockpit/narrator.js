// The cockpit narration spine.
//
// The autonomous system already produces everything worth watching: events,
// theses, challenges, syntheses, risk verdicts, order transitions. What it did
// not have was a place to say so in order, so an operator could watch it work.
//
// This is that place. It is a bounded, sequenced, in-memory log that the
// runtime writes to at the points where something genuinely happened, and that
// the cockpit reads and streams.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: nothing here generates activity. There
// is no timer, no synthetic event, no "thinking" animation. If the market is
// quiet the log is silent, and the cockpit shows a quiet market. A narrator
// that invented activity would make the interface a lie, and the whole point of
// watching an autonomous trader is that what you see is what it did.

export const KIND = {
    // market
    SESSION: "SESSION",
    MARKET_OBSERVATION: "MARKET_OBSERVATION",
    MARKET_EVENT: "MARKET_EVENT",
    NEWS_EVENT: "NEWS_EVENT",
    MATERIALITY: "MATERIALITY",
    // reasoning
    REASONING_STARTED: "REASONING_STARTED",
    WHAT_I_KNOW: "WHAT_I_KNOW",
    THESIS_FORMED: "THESIS_FORMED",
    THESIS_CHALLENGED: "THESIS_CHALLENGED",
    ALTERNATIVES: "ALTERNATIVES",
    WHAT_WOULD_CHANGE_MY_MIND: "WHAT_WOULD_CHANGE_MY_MIND",
    SYNTHESIS: "SYNTHESIS",
    DECISION: "DECISION",
    REASONING_FINISHED: "REASONING_FINISHED",
    // risk and execution
    REVALIDATION: "REVALIDATION",
    RISK_DECISION: "RISK_DECISION",
    ORDER_STATE_CHANGED: "ORDER_STATE_CHANGED",
    FILL: "FILL",
    // positions
    POSITION_CHANGED: "POSITION_CHANGED",
    REASSESSMENT: "REASSESSMENT",
    PROTECTIVE_EVENT: "PROTECTIVE_EVENT",
    // system
    STALE_DATA: "STALE_DATA",
    RECOVERY: "RECOVERY",
    ERROR: "ERROR",
};

export const CATEGORY = {
    MARKET: "MARKET", REASONING: "REASONING", TRADES: "TRADES",
    POSITIONS: "POSITIONS", RISK: "RISK", SYSTEM: "SYSTEM",
};

const CATEGORY_OF = {
    [KIND.SESSION]: CATEGORY.SYSTEM,
    [KIND.MARKET_OBSERVATION]: CATEGORY.MARKET,
    [KIND.MARKET_EVENT]: CATEGORY.MARKET,
    [KIND.NEWS_EVENT]: CATEGORY.MARKET,
    [KIND.MATERIALITY]: CATEGORY.MARKET,
    [KIND.REASONING_STARTED]: CATEGORY.REASONING,
    [KIND.WHAT_I_KNOW]: CATEGORY.REASONING,
    [KIND.THESIS_FORMED]: CATEGORY.REASONING,
    [KIND.THESIS_CHALLENGED]: CATEGORY.REASONING,
    [KIND.ALTERNATIVES]: CATEGORY.REASONING,
    [KIND.WHAT_WOULD_CHANGE_MY_MIND]: CATEGORY.REASONING,
    [KIND.SYNTHESIS]: CATEGORY.REASONING,
    [KIND.DECISION]: CATEGORY.REASONING,
    [KIND.REASONING_FINISHED]: CATEGORY.REASONING,
    [KIND.REVALIDATION]: CATEGORY.RISK,
    [KIND.RISK_DECISION]: CATEGORY.RISK,
    [KIND.ORDER_STATE_CHANGED]: CATEGORY.TRADES,
    [KIND.FILL]: CATEGORY.TRADES,
    [KIND.POSITION_CHANGED]: CATEGORY.POSITIONS,
    [KIND.REASSESSMENT]: CATEGORY.POSITIONS,
    [KIND.PROTECTIVE_EVENT]: CATEGORY.POSITIONS,
    [KIND.STALE_DATA]: CATEGORY.SYSTEM,
    [KIND.RECOVERY]: CATEGORY.SYSTEM,
    [KIND.ERROR]: CATEGORY.SYSTEM,
};

// What the brain is doing right now, derived from what it last reported rather
// than asserted by a caller that might be wrong.
export const BRAIN = {
    IDLE: "IDLE", THINKING: "THINKING", EXECUTING: "EXECUTING",
    MONITORING: "MONITORING",
};

export const DEFAULT_CAPACITY = 2_000;

export const categoryOf = (kind) => CATEGORY_OF[kind] ?? CATEGORY.SYSTEM;

export class Narrator {
    constructor({ capacity = DEFAULT_CAPACITY, clock = () => new Date(),
                  logger = null } = {}) {
        this.capacity = capacity;
        this.clock = clock;
        this.logger = logger;
        this.seq = 0;
        this.log = [];
        this.subscribers = new Set();

        // Derived state, so a browser that connects mid-session sees where
        // things stand rather than an empty screen until the next event.
        this.brain = BRAIN.IDLE;
        this.currentThought = null;
        this.lastEventAt = null;
        this.counters = { reasoningCalls: 0, decisions: 0, orders: 0, fills: 0,
                          protective: 0, errors: 0 };
        this.decisionCards = [];
        this.sessionDate = null;
        this.publisher = null;
        this.consumer = null;
    }

    subscribe(fn) {
        this.subscribers.add(fn);
        return () => this.subscribers.delete(fn);
    }

    // ---- crossing a process boundary -------------------------------------
    //
    // The autonomous runtime and the API are separate processes: the brain can
    // restart without dropping the cockpit, and the cockpit can be reloaded
    // without disturbing the brain. Narration therefore has a writer side and a
    // reader side.
    //
    // The WRITER assigns the sequence. The READER preserves it. If both
    // assigned their own, a browser reconnecting to the reader would dedupe
    // against numbers the writer never used.

    // Writer: mirror every emit onto a channel. Fire and forget — a cockpit
    // nobody is watching must not slow a decision down.
    publishTo(client, channel) {
        this.publisher = { client, channel };
        return this.subscribe((event) => {
            client.publish(channel, JSON.stringify(event)).catch((err) =>
                this.logger?.warn?.("Narrator", "narration not published",
                                    { error: err.message, kind: event.kind }));
        });
    }

    // Reader: apply an event that was assigned its identity elsewhere.
    //
    // Out-of-order and duplicate arrivals are dropped rather than renumbered,
    // because the sequence is what every downstream consumer dedupes on.
    ingest(event) {
        if (!event || !CATEGORY_OF[event.kind]) return null;
        if (!Number.isFinite(event.seq) || event.seq <= this.seq) return null;

        this.seq = event.seq;
        this.log.push(event);
        if (this.log.length > this.capacity) {
            this.log.splice(0, this.log.length - this.capacity);
        }
        this.lastEventAt = event.at;
        this.rollSession(new Date(event.at));
        this.applyToState(event);

        for (const fn of this.subscribers) {
            try { fn(event); } catch (err) {
                this.logger?.error?.("Narrator", "subscriber threw",
                                     { error: err.message, kind: event.kind });
            }
        }
        return event;
    }

    // Reader: follow a writer on another process. Returns a stop function.
    async consumeFrom(client, channel) {
        const subscriber = client.duplicate();
        subscriber.on("error", (err) =>
            this.logger?.warn?.("Narrator", "narration subscriber error",
                                { error: err.message }));
        await subscriber.subscribe(channel);
        subscriber.on("message", (from, payload) => {
            if (from !== channel) return;
            try { this.ingest(JSON.parse(payload)); } catch { /* malformed */ }
        });
        this.consumer = subscriber;
        return async () => {
            try { await subscriber.quit(); } catch { /* already gone */ }
            this.consumer = null;
        };
    }

    // The single write path. Every field is supplied by the caller from real
    // system state; this adds identity, ordering and time.
    emit(kind, payload = {}) {
        if (!CATEGORY_OF[kind]) throw new Error(`unknown narration kind: ${kind}`);
        const at = this.clock();
        this.rollSession(at);

        this.seq += 1;
        // Identity is assigned LAST and cannot be overwritten by a payload.
        //
        // Spreading the payload after these fields let a caller passing its own
        // `kind` silently replace the event's identity: a PROTECTIVE_EVENT
        // carrying `{ kind: "STOP" }` became an event of kind "STOP", which is
        // not in the vocabulary, routes nowhere and renders as nothing. The
        // event knows what it is; the payload only describes it.
        const event = {
            ...payload,
            seq: this.seq,
            at: at.toISOString(),
            kind,
            category: categoryOf(kind),
        };

        this.log.push(event);
        if (this.log.length > this.capacity) {
            this.log.splice(0, this.log.length - this.capacity);
        }
        this.lastEventAt = event.at;
        this.applyToState(event);

        for (const fn of this.subscribers) {
            try { fn(event); } catch (err) {
                this.logger?.error?.("Narrator", "subscriber threw",
                                     { error: err.message, kind });
            }
        }
        return event;
    }

    // Counters are per session, not for the life of the process: "reasoning
    // calls today" has to mean today.
    rollSession(at) {
        if (Number.isNaN(at?.getTime?.())) return;
        const ist = new Date(at.getTime() + 5.5 * 60 * 60 * 1000)
            .toISOString().slice(0, 10);
        if (this.sessionDate === ist) return;
        this.sessionDate = ist;
        this.counters = { reasoningCalls: 0, decisions: 0, orders: 0, fills: 0,
                          protective: 0, errors: 0 };
    }

    applyToState(event) {
        switch (event.kind) {
            case KIND.REASONING_STARTED:
                this.brain = BRAIN.THINKING;
                this.counters.reasoningCalls += 1;
                this.currentThought = {
                    symbol: event.symbol ?? null,
                    trigger: event.trigger ?? null,
                    route: event.route ?? null,
                    correlationId: event.correlationId ?? null,
                    startedAt: event.at,
                    stages: [],
                };
                break;
            case KIND.WHAT_I_KNOW:
            case KIND.THESIS_FORMED:
            case KIND.THESIS_CHALLENGED:
            case KIND.ALTERNATIVES:
            case KIND.WHAT_WOULD_CHANGE_MY_MIND:
            case KIND.SYNTHESIS:
                if (this.currentThought) this.currentThought.stages.push(event);
                break;
            case KIND.DECISION:
                this.counters.decisions += 1;
                if (this.currentThought) {
                    this.currentThought.stages.push(event);
                    this.currentThought.decision = event.action ?? null;
                }
                break;
            case KIND.ORDER_STATE_CHANGED:
                this.brain = BRAIN.EXECUTING;
                this.counters.orders += 1;
                break;
            case KIND.FILL:
                this.counters.fills += 1;
                break;
            case KIND.PROTECTIVE_EVENT:
                this.counters.protective += 1;
                break;
            case KIND.ERROR:
                this.counters.errors += 1;
                break;
            case KIND.REASONING_FINISHED:
                // Back to watching. The brain is only THINKING while it is.
                this.brain = event.holdingPositions ? BRAIN.MONITORING : BRAIN.IDLE;
                if (event.card) this.recordCard(event.card);
                this.currentThought = null;
                break;
            default:
                break;
        }
    }

    // A permanent record of every autonomous decision that reached an order.
    recordCard(card) {
        this.decisionCards.unshift({ ...card, seq: this.seq, at: this.lastEventAt });
        if (this.decisionCards.length > 100) this.decisionCards.length = 100;
    }

    // Events strictly after `seq`. This is what makes a browser refresh safe:
    // the client says what it already has, and gets only what it does not.
    since(seq = 0, limit = 500) {
        const after = Number.isFinite(seq) ? seq : 0;
        const out = [];
        for (let i = this.log.length - 1; i >= 0; i -= 1) {
            if (this.log[i].seq <= after) break;
            out.push(this.log[i]);
            if (out.length >= limit) break;
        }
        return out.reverse();
    }

    recent(limit = 300, category = null) {
        const filtered = category
            ? this.log.filter((e) => e.category === category) : this.log;
        return filtered.slice(-limit);
    }

    // Everything a freshly connected browser needs to render the whole screen
    // before the first live event arrives.
    snapshot({ limit = 300 } = {}) {
        return {
            seq: this.seq,
            brain: this.brain,
            currentThought: this.currentThought,
            lastEventAt: this.lastEventAt,
            counters: { ...this.counters },
            sessionDate: this.sessionDate,
            events: this.recent(limit),
            decisionCards: this.decisionCards.slice(0, 25),
            // Capacity is exposed so the client can tell "nothing happened"
            // from "the buffer rolled".
            capacity: this.capacity,
            oldestSeq: this.log.length ? this.log[0].seq : this.seq,
        };
    }

    health() {
        return { seq: this.seq, buffered: this.log.length, capacity: this.capacity,
                 subscribers: this.subscribers.size, brain: this.brain,
                 publishing: Boolean(this.publisher),
                 consuming: Boolean(this.consumer),
                 counters: { ...this.counters } };
    }
}

// The channel the runtime publishes narration on and the API reads it from.
export const NARRATION_CHANNEL = "cockpit:narration";

// Where the runtime publishes its own health, so the API can tell "the brain is
// quiet" from "the brain is gone" — identical on the wire, very different in a
// session. Short TTL, so a dead runtime disappears instead of leaving a record
// that reads as healthy.
export const RUNTIME_HEALTH_KEY = "cockpit:runtime:health";
export const RUNTIME_HEALTH_TTL_SECONDS = 20;

// One narrator per process. In the agent process the runtime writes to it; in
// the API process it follows the agent and the transport reads it.
export const narrator = new Narrator();
