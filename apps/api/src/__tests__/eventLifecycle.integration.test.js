import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// F5 / F12. An event had identity but no lifecycle, so a condition raised once
// and dropped by the queue could never be raised again, and a crash between
// persisting and reasoning lost it permanently.

describe.skipIf(!TEST_DB || !TEST_REDIS)("event lifecycle", () => {
    let pool, redis, buildLivePorts, Orchestrator, makeEvent, NewsStore, ConnectionTracker;
    const USER = 8492;
    const SYMBOL = "RELIANCE";

    beforeEach(async () => {
        ({ pool } = await import("../config/db.js"));
        ({ default: redis } = await import("../config/redis.js"));
        ({ buildLivePorts } = await import("../services/autonomous/livePorts.js"));
        ({ Orchestrator } = await import("../services/orchestrator/orchestrator.js"));
        ({ makeEvent } = await import("../services/autonomous/events.js"));
        ({ NewsStore } = await import("../services/news/ingest.js"));
        ({ ConnectionTracker } = await import("../services/orchestrator/connectionState.js"));

        await pool.query("DELETE FROM position_events WHERE user_id=$1", [USER]);
        // Cooldowns are durable now, so a symbol priced by one test would
        // otherwise be skipped by the next.
        await pool.query("DELETE FROM candidate_cooldowns WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM trade_thesis WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'evt@test',100000000)
             ON CONFLICT (id) DO NOTHING`, [USER]);
    });

    afterAll(async () => {
        if (pool) await pool.end();
        if (redis) await redis.quit();
    });

    const ports = () => buildLivePorts({
        userId: USER, newsStore: new NewsStore(),
        connectionTracker: new ConnectionTracker(), universe: [SYMBOL] });

    const event = (over = {}) => makeEvent({
        type: "PRICE_JUMP", symbol: SYMBOL, severity: "WARNING",
        correlationId: "c", source: "anomaly_engine", observed: {},
        reason: "moved 3%", observedAt: new Date("2026-08-31T05:00:00Z"),
        bucket: "pwarning", ...over });

    const seedThesis = async () => {
        const { rows } = await pool.query(
            `INSERT INTO trade_thesis (user_id, symbol, correlation_id, side, entry_price_paise,
                quantity, rationale, setup_type, invalidation_conditions, supporting_evidence, horizon)
             VALUES ($1,$2,$3,'BUY',100000,100,'r','breakout','["x"]'::jsonb,'[]'::jsonb,'INTRADAY')
             RETURNING id`, [USER, SYMBOL, `evt-${Date.now()}-${Math.random()}`]);
        return rows[0].id;
    };

    const stateOf = async (key) => {
        const { rows } = await pool.query(
            "SELECT state, severity, handled_at, attempts FROM position_events WHERE event_key=$1", [key]);
        return rows[0] ?? null;
    };

    it("a fresh condition is recorded PENDING and returned for queueing", async () => {
        const p = ports();
        const stored = await p.recordEvent(event());
        expect(stored).toBeTruthy();
        expect((await stateOf(event().key)).state).toBe("PENDING");
    });

    it("re-observing a still-pending condition refreshes it instead of discarding it", async () => {
        const p = ports();
        const first = await p.recordEvent(event());
        const second = await p.recordEvent(event());
        // This is the fix: the old code returned null here and the orchestrator
        // skipped, so a dropped event could never come back.
        expect(second).toBeTruthy();
        expect(second.id).toBe(first.id);
    });

    it("a handled condition is genuinely deduplicated", async () => {
        const p = ports();
        const stored = await p.recordEvent(event());
        await p.markEventHandled(stored.id);
        expect(await p.recordEvent(event())).toBeNull();
        expect((await stateOf(event().key)).state).toBe("HANDLED");
    });

    it("severity is monotonic: a later WARNING cannot downgrade a CRITICAL", async () => {
        const p = ports();
        await p.recordEvent(event({ severity: "CRITICAL" }));
        const after = await p.recordEvent(event({ severity: "WARNING" }));
        expect(after.severity).toBe("CRITICAL");
        expect((await stateOf(event().key)).severity).toBe("CRITICAL");
    });

    it("a failed attempt returns the condition to PENDING and counts the attempt", async () => {
        const p = ports();
        const stored = await p.recordEvent(event());
        await p.markEventFailed(stored.id, "model timeout");
        const row = await stateOf(event().key);
        expect(row.state).toBe("PENDING");
        expect(row.attempts).toBe(1);
    });

    it("pending work survives a restart", async () => {
        const p = ports();
        await p.recordEvent(event({ severity: "CRITICAL" }));
        await p.recordEvent(event({ type: "VOLUME_SPIKE", bucket: "vwarning" }));

        const recovered = await p.loadPendingEvents();
        expect(recovered).toHaveLength(2);
        // Worst first.
        expect(recovered[0].severity).toBe("CRITICAL");
        expect(recovered[0].storedId).toBeTruthy();
    });

    it("a handled event is not resurrected by recovery", async () => {
        const p = ports();
        const stored = await p.recordEvent(event());
        await p.markEventHandled(stored.id);
        expect(await p.loadPendingEvents()).toHaveLength(0);
    });

    it("the orchestrator re-queues pending work on recover", async () => {
        const p = ports();
        await p.recordEvent(event({ severity: "CRITICAL" }));
        const o = new Orchestrator({ clock: () => new Date("2026-08-31T05:00:30Z"), ports: p });
        const recovery = await o.recover();
        expect(recovery.pendingEvents).toBe(1);
        expect(recovery.requeuedEvents).toBe(1);
        expect(o.queue.size).toBe(1);
    });

    it("a critical condition dropped by a full queue is returned to the store, not lost", async () => {
        const p = ports();
        const stored = await p.recordEvent(event({ severity: "CRITICAL" }));
        const o = new Orchestrator({
            clock: () => new Date("2026-08-31T05:00:30Z"),
            ports: { ...p, reassess: async () => ({ action: "HOLD" }) },
        });
        // Simulate the queue evicting it.
        o.queue.released.push({ ...event({ severity: "CRITICAL" }), storedId: stored.id });
        await o.reasoningCycle();
        const row = await stateOf(event().key);
        expect(row.state).toBe("PENDING");     // still outstanding
        expect(row.handled_at).toBeNull();
        expect(o.metrics.eventsReleased).toBe(1);
    });

    it("an event is only marked handled after reasoning actually completed", async () => {
        const p = ports();
        const thesisId = await seedThesis();
        const positionEvent = event({ severity: "CRITICAL", thesisId });
        const stored = await p.recordEvent(positionEvent);
        const o = new Orchestrator({
            clock: () => new Date("2026-08-31T05:00:30Z"),
            ports: {
                ...p,
                positionFor: async () => { throw new Error("database gone"); },
            },
        });
        o.queue.offer({ ...positionEvent, storedId: stored.id },
                      Date.parse("2026-08-31T05:00:30Z"));
        await o.reasoningCycle();
        const row = await stateOf(positionEvent.key);
        expect(row.state).toBe("PENDING");     // the crash did not consume it
        expect(row.attempts).toBe(1);
    });

    it("a position event keeps its thesis through persistence and recovery", async () => {
        const p = ports();
        const thesisId = await seedThesis();
        await p.recordEvent(event({ severity: "CRITICAL", thesisId }));
        const [recovered] = await p.loadPendingEvents();
        // Without the thesis id a recovered position event routes as a
        // candidate, which asks the wrong question about a symbol we hold.
        expect(recovered.thesisId).toBe(thesisId);
    });
});
