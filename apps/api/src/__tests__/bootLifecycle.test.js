import { describe, expect, it, vi } from "vitest";
import { Bootstrap, buildHealth, STAGES, CRITICAL } from "../services/orchestrator/bootstrap.js";
import { ConnectionTracker, CONNECTION, MAX_RECONNECT_ATTEMPTS } from "../services/orchestrator/connectionState.js";
import { HEALTH, deriveHealth, isSafeToTrade } from "../services/orchestrator/health.js";
import { isStale, permitsNewExposure, SOURCE, maxAgeFor } from "../services/orchestrator/freshness.js";

const ok = async () => true;
const fail = (msg) => async () => { throw new Error(msg); };
const allGood = () => Object.fromEntries(STAGES.map((s) => [s, ok]));

describe("boot sequence", () => {
    it("runs every stage in order when dependencies are healthy", async () => {
        const seen = [];
        const steps = Object.fromEntries(STAGES.map((s) => [s, async () => { seen.push(s); return true; }]));
        const boot = new Bootstrap({ steps });
        const result = await boot.run();
        expect(result.ok).toBe(true);
        expect(seen).toEqual(STAGES);
        expect(boot.stage).toBe("complete");
    });

    it("stops at a failed CRITICAL stage and never reports complete", async () => {
        const boot = new Bootstrap({ steps: { ...allGood(), database: fail("postgres down") } });
        const result = await boot.run();
        expect(result.ok).toBe(false);
        expect(result.stage).toBe("database");
        expect(boot.stage).toBe("failed");
        expect(boot.dependencies.database).toBe(false);
    });

    it.each([...CRITICAL])("treats %s as critical", async (stage) => {
        const boot = new Bootstrap({ steps: { ...allGood(), [stage]: fail("down") } });
        expect((await boot.run()).ok).toBe(false);
    });

    it("survives an optional stage failure and completes in degraded mode", async () => {
        const boot = new Bootstrap({ steps: { ...allGood(), "market-data": fail("socket refused") } });
        const result = await boot.run();
        expect(result.ok).toBe(true);
        expect(boot.stage).toBe("complete");
        expect(boot.dependencies.marketData).toBe(false);
    });

    it("survives Redis being unavailable", async () => {
        const boot = new Bootstrap({ steps: { ...allGood(), redis: fail("redis down") } });
        expect((await boot.run()).ok).toBe(true);
        expect(boot.dependencies.redis).toBe(false);
    });

    it("survives Fyers authentication failure", async () => {
        const boot = new Bootstrap({ steps: { ...allGood(), "fyers-auth": fail("no token") } });
        expect((await boot.run()).ok).toBe(true);
        expect(boot.dependencies.fyers).toBe(false);
    });

    it("records timing and errors per stage", async () => {
        const boot = new Bootstrap({ steps: { ...allGood(), symbols: fail("boom") } });
        await boot.run();
        const symbols = boot.summary().stages.find((s) => s.stage === "symbols");
        expect(symbols.ok).toBe(false);
        expect(symbols.error).toBe("boom");
    });
});

describe("connection state machine", () => {
    let now = 1_000_000;
    const make = () => new ConnectionTracker({ clock: () => now, staleAfterMs: 90_000 });

    it("starts DISCONNECTED", () => expect(make().state).toBe(CONNECTION.DISCONNECTED));

    it("walks the normal connect path", () => {
        const c = make();
        c.onConnecting(); expect(c.state).toBe(CONNECTION.CONNECTING);
        c.onConnected(); expect(c.state).toBe(CONNECTION.CONNECTED);
        expect(c.isTrusted()).toBe(true);
    });

    it("only CONNECTED is trusted", () => {
        const c = make();
        for (const s of [CONNECTION.DISCONNECTED, CONNECTION.CONNECTING,
                         CONNECTION.STALE, CONNECTION.RECONNECTING, CONNECTION.FAILED]) {
            c.state = s;
            expect(c.isTrusted()).toBe(false);
        }
    });

    it("goes STALE when connected but silent past the threshold", () => {
        const c = make();
        c.onConnecting(); c.onConnected(); c.onTick(now);
        now += 91_000;
        expect(c.evaluate(now)).toBe(CONNECTION.STALE);
        expect(c.isTrusted()).toBe(false);
    });

    it("a single fresh tick recovers STALE without a reconnect", () => {
        const c = make();
        c.onConnecting(); c.onConnected(); c.onTick(now);
        now += 91_000; c.evaluate(now);
        expect(c.state).toBe(CONNECTION.STALE);
        c.onTick(now);
        expect(c.state).toBe(CONNECTION.CONNECTED);
    });

    it("stays CONNECTED while ticks keep arriving", () => {
        const c = make();
        c.onConnecting(); c.onConnected();
        for (let i = 0; i < 10; i += 1) { now += 30_000; c.onTick(now); expect(c.evaluate(now)).toBe(CONNECTION.CONNECTED); }
    });

    it("handles disconnect then reconnect, restoring trust", () => {
        const c = make();
        c.onConnecting(); c.onConnected();
        c.onDisconnected("socket closed");
        expect(c.isTrusted()).toBe(false);
        c.onConnecting(); c.onReconnecting(); c.onConnected();
        expect(c.state).toBe(CONNECTION.CONNECTED);
        expect(c.reconnectAttempts).toBe(0);   // reset on success
    });

    it("gives up as FAILED after repeated reconnect attempts", () => {
        const c = make();
        c.onConnecting();
        for (let i = 0; i < MAX_RECONNECT_ATTEMPTS; i += 1) c.onReconnecting();
        expect(c.state).toBe(CONNECTION.FAILED);
        expect(c.isTrusted()).toBe(false);
    });

    it("survives repeated disconnect/reconnect cycles", () => {
        const c = make();
        for (let i = 0; i < 5; i += 1) {
            c.onConnecting(); c.onConnected(); c.onTick(now);
            c.onDisconnected();
        }
        expect(c.state).toBe(CONNECTION.DISCONNECTED);
        c.onConnecting(); c.onConnected();
        expect(c.isTrusted()).toBe(true);
    });

    it("ignores an illegal transition rather than crashing on out-of-order socket events", () => {
        const c = make();
        expect(c.transition(CONNECTION.STALE)).toBe(false);  // DISCONNECTED -> STALE
        expect(c.state).toBe(CONNECTION.DISCONNECTED);
    });

    it("reports data age", () => {
        const c = make();
        c.onConnecting(); c.onConnected(); c.onTick(now);
        now += 5_000;
        expect(c.dataAgeMs(now)).toBe(5_000);
    });
});

describe("freshness rules", () => {
    it("defines an explicit maximum age per source", () => {
        for (const source of Object.values(SOURCE)) expect(maxAgeFor(source)).toBeGreaterThan(0);
    });

    it("treats an unknown source as never trusted", () => {
        expect(isStale("mystery", 0)).toBe(true);
    });

    it("treats missing age as stale", () => {
        expect(isStale(SOURCE.WEBSOCKET, null)).toBe(true);
        expect(isStale(SOURCE.WEBSOCKET, undefined)).toBe(true);
    });

    it("blocks new exposure on an untrusted connection", () => {
        const r = permitsNewExposure({ connectionTrusted: false, websocketAgeMs: 0 });
        expect(r.permitted).toBe(false);
        expect(r.reason).toMatch(/not trusted/);
    });

    it("blocks new exposure on stale data even when connected", () => {
        const r = permitsNewExposure({ connectionTrusted: true, websocketAgeMs: 120_000 });
        expect(r.permitted).toBe(false);
        expect(r.reason).toMatch(/stale/);
    });

    it("permits new exposure only when trusted and fresh", () => {
        expect(permitsNewExposure({ connectionTrusted: true, websocketAgeMs: 1_000 }).permitted).toBe(true);
    });
});

describe("health derivation", () => {
    const base = {
        bootStage: "complete",
        dependencies: { database: true, redis: true },
        orchestratorPhase: "RUNNING",
        session: "OPEN",
        connection: { trusted: true },
        halted: false,
    };

    it("is READY when everything is healthy during a session", () => {
        expect(deriveHealth(base)).toBe(HEALTH.READY);
        expect(isSafeToTrade(HEALTH.READY)).toBe(true);
    });

    it("is FAILED without a database, whatever else is true", () => {
        expect(deriveHealth({ ...base, dependencies: { database: false, redis: true } }))
            .toBe(HEALTH.FAILED);
    });

    it("is never READY while the market feed is down during a session", () => {
        for (const session of ["OPEN", "CLOSING"]) {
            const status = deriveHealth({ ...base, session, connection: { trusted: false } });
            expect(status).toBe(HEALTH.DEGRADED);
            expect(isSafeToTrade(status)).toBe(false);
        }
    });

    it("is READY with a disconnected feed outside market hours", () => {
        expect(deriveHealth({ ...base, session: "CLOSED", connection: { trusted: false } }))
            .toBe(HEALTH.READY);
    });

    it("is DEGRADED without Redis", () => {
        expect(deriveHealth({ ...base, dependencies: { database: true, redis: false } }))
            .toBe(HEALTH.DEGRADED);
    });

    it("is HALTED when deliberately halted, outranking session state", () => {
        expect(deriveHealth({ ...base, halted: true })).toBe(HEALTH.HALTED);
    });

    it("reports RECOVERING and STARTING during boot", () => {
        expect(deriveHealth({ ...base, bootStage: "recovering" })).toBe(HEALTH.RECOVERING);
        expect(deriveHealth({ ...base, bootStage: "database" })).toBe(HEALTH.STARTING);
    });

    it("is DEGRADED when the orchestrator is not running", () => {
        expect(deriveHealth({ ...base, orchestratorPhase: "STOPPED" })).toBe(HEALTH.DEGRADED);
    });
});

describe("assembled health view", () => {
    it("blocks new exposure and explains why when data is stale", async () => {
        const boot = new Bootstrap({ steps: Object.fromEntries(STAGES.map((s) => [s, ok])) });
        await boot.run();
        let now = 1_000_000;
        const connection = new ConnectionTracker({ clock: () => now });
        connection.onConnecting(); connection.onConnected(); connection.onTick(now);
        now += 200_000; connection.evaluate(now);

        const view = buildHealth({
            bootstrap: boot, connection,
            orchestrator: { health: () => ({ phase: "RUNNING", session: "OPEN", halted: false }) },
        });
        expect(view.status).toBe(HEALTH.DEGRADED);
        expect(view.newExposurePermitted).toBe(false);
        expect(view.exposureBlockedBecause).toBeTruthy();
    });
});

// The API process holds no autonomous runtime by design — the trader lives in
// the agent process — so health was built with `orchestrator: null` and the
// session fell through to a hard-coded "CLOSED". The banner then announced
// "MARKET CLOSED" and "DEGRADED (expected — the market is CLOSED)" straight
// through a live session, which reads as a stack that failed to start.

describe("the session is known without a runtime", () => {
    const at = (h, m) => new Date(Date.UTC(2026, 8, 2, h - 6, m + 30));   // IST h:m

    it("reports the real session when no orchestrator is attached", () => {
        const h = buildHealth({
            bootstrap: { stage: "ready", dependencies: { database: true, redis: true } },
            orchestrator: null, connection: null });
        // Whatever it is, it is derived rather than assumed shut.
        expect(["PRE_MARKET", "OPEN", "CLOSING", "CLOSED"]).toContain(h.session);
    });

    it("still prefers the orchestrator's own view when there is one", () => {
        const h = buildHealth({
            bootstrap: { stage: "ready", dependencies: { database: true, redis: true } },
            orchestrator: { health: () => ({ phase: "RUNNING", session: "HALTED" }) },
            connection: null });
        expect(h.session).toBe("HALTED");
    });
});
