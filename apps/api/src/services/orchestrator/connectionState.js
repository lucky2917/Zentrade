// Explicit market-data connection state.
//
// The Fyers websocket already reconnects with backoff. What it lacked was an
// observable state the orchestrator and health endpoint could read, so
// "connected but silent for four minutes" was indistinguishable from healthy.
//
// This wraps the existing client. It does not create a second one, does not
// touch credentials, and does not open sockets itself.

export const CONNECTION = {
    DISCONNECTED: "DISCONNECTED",
    CONNECTING: "CONNECTING",
    CONNECTED: "CONNECTED",
    STALE: "STALE",          // socket up, but no data within the freshness bound
    RECONNECTING: "RECONNECTING",
    FAILED: "FAILED",        // give-up state; requires operator or restart
};

export const VALID_TRANSITIONS = {
    [CONNECTION.DISCONNECTED]: new Set([CONNECTION.CONNECTING, CONNECTION.FAILED]),
    [CONNECTION.CONNECTING]: new Set([
        CONNECTION.CONNECTED, CONNECTION.RECONNECTING, CONNECTION.FAILED, CONNECTION.DISCONNECTED,
    ]),
    [CONNECTION.CONNECTED]: new Set([
        CONNECTION.STALE, CONNECTION.RECONNECTING, CONNECTION.DISCONNECTED,
    ]),
    // STALE is recoverable without a reconnect: a tick arriving is enough.
    [CONNECTION.STALE]: new Set([
        CONNECTION.CONNECTED, CONNECTION.RECONNECTING, CONNECTION.DISCONNECTED,
    ]),
    [CONNECTION.RECONNECTING]: new Set([
        CONNECTION.CONNECTED, CONNECTION.RECONNECTING, CONNECTION.FAILED, CONNECTION.DISCONNECTED,
    ]),
    [CONNECTION.FAILED]: new Set([CONNECTION.CONNECTING, CONNECTION.DISCONNECTED]),
};

// Only CONNECTED means observations can be trusted for new exposure. Every
// other state is a reason to stop adding risk.
export const TRUSTED_STATES = new Set([CONNECTION.CONNECTED]);

export const MAX_RECONNECT_ATTEMPTS = 10;

export class ConnectionTracker {
    constructor({ staleAfterMs = 90_000, clock = () => Date.now(), logger = null } = {}) {
        this.state = CONNECTION.DISCONNECTED;
        this.staleAfterMs = staleAfterMs;
        this.clock = clock;
        this.logger = logger;
        this.lastTickAt = null;
        this.lastConnectedAt = null;
        this.reconnectAttempts = 0;
        this.transitions = 0;
        this.history = [];
    }

    canTransition(to) { return Boolean(VALID_TRANSITIONS[this.state]?.has(to)); }

    transition(to, reason = null) {
        if (this.state === to) return false;
        if (!this.canTransition(to)) {
            // A rejected transition is a bug worth surfacing, not a crash: the
            // socket is third-party and may report events out of order.
            this.logger?.warn?.("ConnectionTracker",
                `ignored illegal transition ${this.state} -> ${to}`, { reason });
            return false;
        }
        this.history.push({ from: this.state, to, at: this.clock(), reason });
        if (this.history.length > 50) this.history.shift();
        this.state = to;
        this.transitions += 1;
        if (to === CONNECTION.CONNECTED) {
            this.lastConnectedAt = this.clock();
            this.reconnectAttempts = 0;
        }
        return true;
    }

    onConnecting() { this.transition(CONNECTION.CONNECTING, "connect requested"); }

    onConnected() { this.transition(CONNECTION.CONNECTED, "socket open"); }

    onDisconnected(reason = "socket closed") {
        this.transition(CONNECTION.DISCONNECTED, reason);
    }

    onReconnecting() {
        this.reconnectAttempts += 1;
        this.transition(CONNECTION.RECONNECTING, `attempt ${this.reconnectAttempts}`);
        if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            this.transition(CONNECTION.FAILED, "reconnect attempts exhausted");
        }
    }

    // Every tick is evidence the feed is alive. A tick also clears STALE
    // without needing a reconnect.
    onTick(at = this.clock()) {
        this.lastTickAt = at;
        if (this.state === CONNECTION.STALE) this.transition(CONNECTION.CONNECTED, "tick resumed");
    }

    // A socket that is open but silent is not healthy, and nothing else in the
    // system would notice. A socket that connected and has NEVER delivered a
    // tick is the same condition: silence measured from the connect instant.
    evaluate(now = this.clock()) {
        if (this.state !== CONNECTION.CONNECTED) return this.state;
        const silentSince = this.lastTickAt ?? this.lastConnectedAt;
        if (silentSince === null) return this.state;
        if (now - silentSince > this.staleAfterMs) {
            this.transition(CONNECTION.STALE, this.lastTickAt === null
                ? `no tick since connecting ${now - silentSince}ms ago`
                : `no tick for ${now - silentSince}ms`);
        }
        return this.state;
    }

    // Evaluates before answering. Trust read from a stale snapshot is the bug
    // this class exists to prevent, and callers must not have to remember to
    // call evaluate() first.
    isTrusted(now = this.clock()) {
        this.evaluate(now);
        return TRUSTED_STATES.has(this.state);
    }

    dataAgeMs(now = this.clock()) {
        return this.lastTickAt === null ? null : now - this.lastTickAt;
    }

    health(now = this.clock()) {
        return {
            state: this.state,
            trusted: this.isTrusted(),
            lastTickAt: this.lastTickAt,
            dataAgeMs: this.dataAgeMs(now),
            lastConnectedAt: this.lastConnectedAt,
            reconnectAttempts: this.reconnectAttempts,
            transitions: this.transitions,
        };
    }
}
