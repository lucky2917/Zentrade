import redis from "../../config/redis.js";
import { CROSSING } from "./reflex.js";

// The bridge to the Go fast market plane.
//
// The plane owns world state and evaluates pre-committed levels in a separate
// process, so protection cannot be delayed by reasoning, HTTP serving or a
// nightly job, and cannot die when the brain does. This is the brain's half of
// that boundary: it tells the plane what to protect and reads back what the
// plane saw.
//
// Three modes, and the default is OFF:
//
//   OFF     nothing is published and nothing is read. The Node reflex is the
//           only protection, exactly as before.
//   SHADOW  commands are published and the plane's events are read and
//           COMPARED, but never acted on. The Node reflex stays authoritative.
//           This is what a cutover needs a full session of.
//   LIVE    the plane's events reach the runtime. Not reachable until a shadow
//           session has run with zero divergence.
//
// Nothing here may block or throw into the tick path. A failure degrades the
// bridge and is counted; it never degrades protection, because in OFF and
// SHADOW the Node reflex is still doing the work.

export const PLANE_MODE = { OFF: "off", SHADOW: "shadow", LIVE: "live" };

export const COMMAND_CONTRACT = "zentrade.marketdata.command.v1";
export const EVENT_CONTRACT = "zentrade.marketdata.event.v1";

const COMMAND_CHANNEL = "marketdata:commands";
const COMMAND_STATE = "marketdata:commands:state";
const SHADOW_STREAM = "shadow:marketdata:events";
const LIVE_STREAM = "marketdata:events";
// Push, not poll. A protective crossing must reach the brain in about a
// millisecond, not on a drain interval.
const SHADOW_CHANNEL = "shadow:marketdata:events:live";
const LIVE_CHANNEL = "marketdata:events:live";
const SHADOW_HEALTH = "shadow:marketdata:plane:health";
const LIVE_HEALTH = "marketdata:plane:health";

// Read-and-remove in one atomic step. LRANGE followed by LTRIM is two round
// trips with a window in between, and the plane bounds the same list from the
// other end, so a trim landing in that window would discard unread events.
const DRAIN_EVENTS = `
    local n = tonumber(ARGV[1])
    local items = redis.call('lrange', KEYS[1], 0, n - 1)
    if #items > 0 then
        redis.call('ltrim', KEYS[1], #items, -1)
    end
    return items
`;

export const OP = {
    ARM: "ARM", DISARM: "DISARM", WATCH: "WATCH", UNWATCH: "UNWATCH",
    VWAP: "VWAP", VOLUME_BASELINE: "VOLUME_BASELINE",
};

// The plane's vocabulary for a crossing, which is the reflex's vocabulary with
// STOP/TARGET/INVALIDATION spelled the same way. Kept as an explicit map rather
// than an assumption that the two enums stay identical.
export const KIND_FROM_CROSSING = {
    [CROSSING.STOP]: "STOP",
    [CROSSING.TARGET]: "TARGET",
    [CROSSING.INVALIDATION]: "INVALIDATION",
    [CROSSING.STOP_APPROACH]: "STOP_APPROACH",
    [CROSSING.TARGET_APPROACH]: "TARGET_APPROACH",
    [CROSSING.PRICE_JUMP]: "PRICE_JUMP",
    [CROSSING.VWAP_DEVIATION]: "VWAP_DEVIATION",
    [CROSSING.VOLUME_SPIKE]: "VOLUME_SPIKE",
};

export const modeFromEnv = (value) => {
    const mode = String(value ?? "").toLowerCase();
    return Object.values(PLANE_MODE).includes(mode) ? mode : PLANE_MODE.OFF;
};

export class FastPlaneBridge {
    constructor({ mode = PLANE_MODE.OFF, client = redis, logger = null,
                  clock = () => Date.now() } = {}) {
        this.mode = mode;
        this.client = client;
        this.logger = logger;
        this.clock = clock;
        this.stats = {
            commandsPublished: 0, publishFailures: 0,
            eventsRead: 0, readFailures: 0,
            agreed: 0, onlyPlane: 0, onlyBrain: 0,
        };
        // What the brain believes the plane should be protecting. Held so a
        // restarted plane can replay it instead of protecting nothing until the
        // next entry.
        this.commitments = new Map();
        // The publish chain. Every command joins it, so the wire order is the
        // issue order.
        this.chain = Promise.resolve();
        this.subscriber = null;
    }

    get enabled() { return this.mode !== PLANE_MODE.OFF; }
    // In LIVE the plane OWNS detection: its events drive protection and the
    // Node reflex stops dispatching, so exactly one actor reacts to a crossing.
    get authoritative() { return this.mode === PLANE_MODE.LIVE; }
    get stream() { return this.mode === PLANE_MODE.LIVE ? LIVE_STREAM : SHADOW_STREAM; }
    get channel() { return this.mode === PLANE_MODE.LIVE ? LIVE_CHANNEL : SHADOW_CHANNEL; }
    get healthKey() { return this.mode === PLANE_MODE.LIVE ? LIVE_HEALTH : SHADOW_HEALTH; }

    // Fire and forget for the CALLER, strictly ordered on the WIRE.
    //
    // Each publish used to start its own async chain, so two commands issued
    // microseconds apart raced to Redis and could land inverted. An ARM landing
    // after its own DISARM leaves the plane protecting a position the brain has
    // already closed, and the plane would then fire a protective exit against a
    // holding that no longer exists.
    //
    // Commands are appended to one chain instead. The caller still never waits;
    // the order they were issued in is the order they arrive in.
    publish(command) {
        if (!this.enabled) return false;
        const message = { contract: COMMAND_CONTRACT, issuedTs: this.clock(), ...command };
        this.rememberCommand(message);
        // Snapshot the per-symbol state AT ISSUE TIME. Reading it inside the
        // async write would publish whatever the map held when the write
        // happened to run, which is the same ordering bug one level down.
        const state = JSON.stringify(this.commitments.get(message.symbol) ?? []);

        this.chain = this.chain.then(async () => {
            await this.client.publish(COMMAND_CHANNEL, JSON.stringify(message));
            await this.client.hset(COMMAND_STATE, message.symbol, state);
            this.stats.commandsPublished += 1;
        }).catch((err) => {
            this.stats.publishFailures += 1;
            this.logger?.warn?.("FastPlane", "command not published",
                                { error: err.message, op: message.op, symbol: message.symbol });
        });
        return true;
    }

    // For tests and shutdown: wait for everything already issued to land.
    async flush() { await this.chain; }

    // The per-symbol command set the plane needs to rebuild its state after a
    // restart. ARM and WATCH accumulate; DISARM and UNWATCH remove.
    rememberCommand(message) {
        const { symbol, op } = message;
        if (op === OP.DISARM || op === OP.UNWATCH) {
            const rest = (this.commitments.get(symbol) ?? [])
                .filter((c) => (op === OP.DISARM ? c.op !== OP.ARM : c.op !== OP.WATCH));
            if (rest.length) this.commitments.set(symbol, rest);
            else this.commitments.delete(symbol);
            return;
        }
        const existing = (this.commitments.get(symbol) ?? []).filter((c) => c.op !== op);
        this.commitments.set(symbol, [...existing, message]);
    }

    arm(symbol, commitment) {
        return this.publish({ op: OP.ARM, symbol, commitment: { ...commitment, symbol } });
    }
    disarm(symbol) { return this.publish({ op: OP.DISARM, symbol }); }
    watch(symbol, watch) { return this.publish({ op: OP.WATCH, symbol, watch }); }
    unwatch(symbol) { return this.publish({ op: OP.UNWATCH, symbol }); }
    vwap(symbol, vwapPaise) { return this.publish({ op: OP.VWAP, symbol, vwapPaise }); }
    volumeBaseline(symbol, volumeBaseline, volumeSpikeRatio) {
        return this.publish({ op: OP.VOLUME_BASELINE, symbol, volumeBaseline, volumeSpikeRatio });
    }

    // Live delivery. One dedicated subscriber connection, because a client in
    // subscribe mode cannot serve normal commands.
    //
    // The handler is called on the event loop as the message arrives; it must
    // not throw, and it must not be slow, because everything behind it on this
    // connection waits.
    async listen(onEvent) {
        if (!this.enabled || this.subscriber) return false;
        this.subscriber = this.client.duplicate();
        this.subscriber.on("error", (err) => {
            this.stats.readFailures += 1;
            this.logger?.warn?.("FastPlane", "subscriber error", { error: err.message });
        });
        await this.subscriber.subscribe(this.channel);
        this.subscriber.on("message", (channel, payload) => {
            if (channel !== this.channel) return;
            let event;
            try { event = JSON.parse(payload); } catch { return; }
            // Unknown contract is rejected, never interpreted.
            if (event?.contract !== EVENT_CONTRACT) return;
            this.stats.eventsRead += 1;
            try { onEvent(event); } catch (err) {
                this.logger?.warn?.("FastPlane", "event handler threw",
                                    { error: err.message, kind: event.kind });
            }
        });
        this.logger?.info?.("FastPlane", "listening to the plane",
                            { channel: this.channel, mode: this.mode });
        return true;
    }

    async stop() {
        if (!this.subscriber) return false;
        try { await this.subscriber.quit(); } catch { /* already gone */ }
        this.subscriber = null;
        return true;
    }

    // The plane's own heartbeat, written on the sweep it already runs. A key
    // that has expired means the plane is dead, which on the wire looks exactly
    // like a plane with nothing to say.
    async planeHealth() {
        if (!this.enabled) return null;
        try {
            const raw = await this.client.get(this.healthKey);
            if (!raw) return { alive: false, reason: "no heartbeat from the plane" };
            const parsed = JSON.parse(raw);
            return { alive: true, ...parsed };
        } catch (err) {
            this.stats.readFailures += 1;
            return { alive: false, reason: err.message };
        }
    }

    // Everything the plane has emitted since the last read. Bounded, because a
    // brain that fell behind must not be handed an unbounded backlog.
    async drainEvents(limit = 500) {
        if (!this.enabled) return [];
        try {
            // Read and remove in ONE round trip. A read followed by a separate
            // trim races the plane's own bounding trim: if the list were trimmed
            // between the two, this would delete events it never read.
            const raw = await this.client.eval(DRAIN_EVENTS, 1, this.stream, String(limit));
            if (!raw?.length) return [];
            const events = [];
            for (const entry of raw) {
                try {
                    const event = JSON.parse(entry);
                    // Unknown contract is rejected, never interpreted.
                    if (event?.contract !== EVENT_CONTRACT) continue;
                    events.push(event);
                } catch { /* a malformed entry is not a reason to stop reading */ }
            }
            this.stats.eventsRead += events.length;
            return events;
        } catch (err) {
            this.stats.readFailures += 1;
            this.logger?.warn?.("FastPlane", "could not read the plane's events",
                                { error: err.message });
            return [];
        }
    }

    // Shadow accounting. Two implementations agreeing on a session's traffic is
    // the evidence a cutover needs; a count of where they disagreed is the
    // evidence it is not ready.
    //
    // Identity is (kind, symbol, price, level) — not the timestamp, because the
    // two runtimes stamp their own receipt times.
    static identityOf(kind, symbol, pricePaise, levelPaise) {
        return `${kind}:${symbol}:${pricePaise}:${levelPaise}`;
    }

    reconcile(brainCrossings = [], planeEvents = []) {
        const brain = new Set(brainCrossings.map((c) => FastPlaneBridge.identityOf(
            KIND_FROM_CROSSING[c.kind] ?? c.kind, c.symbol, c.pricePaise, c.levelPaise)));
        const plane = new Set(planeEvents.map((e) => FastPlaneBridge.identityOf(
            e.kind, e.symbol, e.pricePaise, e.levelPaise)));

        let agreed = 0;
        for (const id of plane) {
            if (brain.has(id)) agreed += 1;
            else this.stats.onlyPlane += 1;
        }
        for (const id of brain) if (!plane.has(id)) this.stats.onlyBrain += 1;
        this.stats.agreed += agreed;

        return {
            agreed,
            onlyPlane: [...plane].filter((id) => !brain.has(id)),
            onlyBrain: [...brain].filter((id) => !plane.has(id)),
        };
    }

    health() {
        return {
            mode: this.mode,
            authoritative: this.authoritative,
            trackedSymbols: this.commitments.size,
            listening: Boolean(this.subscriber),
            ...this.stats,
            // Divergence is the number that decides whether a cutover is safe.
            divergence: this.stats.onlyPlane + this.stats.onlyBrain,
        };
    }
}
