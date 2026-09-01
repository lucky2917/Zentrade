import { describe, expect, it, vi } from "vitest";
import { Scheduler } from "../services/orchestrator/scheduler.js";
import { EventQueue } from "../services/orchestrator/eventQueue.js";
import {
    SESSION, sessionStateAt, permits, policyFor, isTradingDay,
} from "../services/orchestrator/session.js";
import { Orchestrator, PHASE } from "../services/orchestrator/orchestrator.js";
import { makeEvent, SEVERITY } from "../services/autonomous/events.js";

// 2026-09-01 is a Tuesday. IST = UTC+5:30, so UTC minutes = IST minutes - 330.
// Borrowing has to move the hour, which a per-field subtraction does not do.
const at = (h, m) => {
    const utcMinutes = h * 60 + m - 330;
    return new Date(Date.UTC(2026, 8, 1, 0, utcMinutes));
};

describe("session model", () => {
    it.each([
        [8, 0, SESSION.CLOSED], [9, 5, SESSION.PRE_MARKET], [9, 14, SESSION.PRE_MARKET],
        [9, 15, SESSION.OPEN], [12, 0, SESSION.OPEN], [15, 19, SESSION.OPEN],
        [15, 20, SESSION.CLOSING], [15, 30, SESSION.CLOSING], [15, 31, SESSION.CLOSED],
    ])("%s:%s IST is %s", (h, m, want) => {
        expect(sessionStateAt(at(h, m))).toBe(want);
    });

    it("is CLOSED at weekends", () => {
        expect(sessionStateAt(new Date(Date.UTC(2026, 8, 5, 7, 0)))).toBe(SESSION.CLOSED);
        expect(isTradingDay(new Date(Date.UTC(2026, 8, 5, 7, 0)))).toBe(false);
    });

    it("HALTED overrides an open clock", () => {
        expect(sessionStateAt(at(12, 0), { halted: true })).toBe(SESSION.HALTED);
    });

    it("permits exits but not new exposure in the closing window", () => {
        expect(permits(SESSION.CLOSING, "exits")).toBe(true);
        expect(permits(SESSION.CLOSING, "newExposure")).toBe(false);
    });

    it("permits no trading at all when closed or halted", () => {
        for (const s of [SESSION.CLOSED, SESSION.HALTED, SESSION.PRE_MARKET]) {
            expect(permits(s, "newExposure")).toBe(false);
        }
        expect(permits(SESSION.HALTED, "exits")).toBe(false);
    });

    it("keeps positions observable and reconciliation running in every state", () => {
        for (const s of Object.values(SESSION)) {
            expect(policyFor(s).positionMonitor).toBe(true);
            expect(policyFor(s).reconciliation).toBe(true);
        }
    });

    it("falls back to the safest policy for an unknown state", () => {
        expect(policyFor("NONSENSE").newExposure).toBe(false);
    });
});

describe("scheduler lifecycle", () => {
    const make = () => new Scheduler({ clock: () => new Date("2026-09-01T06:00:00Z") });

    it("starts once; a duplicate start is a no-op", () => {
        const s = make().register({ name: "j", intervalMs: 1000, run: async () => {} });
        expect(s.start()).toBe(true);
        expect(s.start()).toBe(false);
        expect(s.timers.size).toBe(1);
        return s.stop();
    });

    it("stops cleanly; a duplicate stop is a no-op", async () => {
        const s = make().register({ name: "j", intervalMs: 1000, run: async () => {} });
        s.start();
        expect(await s.stop()).toBe(true);
        expect(await s.stop()).toBe(false);
        expect(s.timers.size).toBe(0);
    });

    it("refuses to register the same job twice", () => {
        const s = make().register({ name: "j", intervalMs: 1000, run: async () => {} });
        expect(() => s.register({ name: "j", intervalMs: 1000, run: async () => {} })).toThrow(/already/);
    });

    it("isolates a throwing job: the scheduler and other jobs survive", async () => {
        const good = vi.fn(async () => {});
        const s = make()
            .register({ name: "bad", intervalMs: 1000, run: async () => { throw new Error("boom"); } })
            .register({ name: "good", intervalMs: 1000, run: good });
        const bad = await s.runJobOnce("bad");
        await s.runJobOnce("good");
        expect(bad.ok).toBe(false);
        expect(good).toHaveBeenCalledOnce();
        expect(s.health().jobs.find((j) => j.name === "bad").failures).toBe(1);
    });

    it("a job failure is visible in health rather than silent", async () => {
        const s = make().register({ name: "bad", intervalMs: 1000, run: async () => { throw new Error("visible"); } });
        await s.runJobOnce("bad");
        const job = s.health().jobs[0];
        expect(job.lastError).toBe("visible");
        expect(job.failures).toBe(1);
    });

    it("never overlaps a job with itself", async () => {
        let concurrent = 0, maxConcurrent = 0;
        const s = make().register({
            name: "slow", intervalMs: 10,
            run: async () => {
                concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
                await new Promise((r) => setTimeout(r, 30));
                concurrent -= 1;
            },
        });
        await Promise.all([s.runJobOnce("slow"), s.runJobOnce("slow"), s.runJobOnce("slow")]);
        expect(maxConcurrent).toBe(1);
        expect(s.health().jobs[0].skipped).toBe(2);
    });

    it("skips a job whose shouldRun is false, and survives a throwing shouldRun", async () => {
        const run = vi.fn(async () => {});
        const s = make()
            .register({ name: "gated", intervalMs: 10, shouldRun: () => false, run })
            .register({ name: "broken", intervalMs: 10,
                        shouldRun: () => { throw new Error("gate"); }, run });
        expect((await s.runJobOnce("gated")).skipped).toBe("not-permitted");
        expect((await s.runJobOnce("broken")).skipped).toBe("shouldRun-failed");
        expect(run).not.toHaveBeenCalled();
    });

    it("reports overrunning jobs", async () => {
        const s = make().register({
            name: "over", intervalMs: 5,
            run: async () => new Promise((r) => setTimeout(r, 25)),
        });
        await s.runJobOnce("over");
        expect(s.health().jobs[0].overrunning).toBe(true);
    });
});

describe("event queue backpressure", () => {
    let now = 1_000_000;
    const clock = () => now;
    const ev = (type, symbol, severity = SEVERITY.WARNING, suffix = "") => makeEvent({
        type, symbol, severity, thesisId: "t-1", correlationId: "c",
        source: "test", observed: {}, reason: "r",
        observedAt: new Date(now), bucket: `b${suffix}`,
    });

    it("collapses a repeated condition into one queued item", () => {
        const q = new EventQueue({ clock });
        expect(q.offer(ev("STOP_BREACH", "A"))).toBe("admitted");
        // Coalesced rather than permanently suppressed: an in-memory "seen for
        // ever" set meant a condition dropped once could never be re-queued.
        expect(q.offer(ev("STOP_BREACH", "A"))).toBe("coalesced");
        expect(q.size).toBe(1);
    });

    it("a repeated condition can be queued again after it was handled", () => {
        const q = new EventQueue({ clock });
        q.offer(ev("STOP_BREACH", "A"));
        expect(q.drain(1)).toHaveLength(1);
        expect(q.offer(ev("STOP_BREACH", "A"))).toBe("admitted");
    });

    it("coalesces a newer event over an older one for the same position", () => {
        const q = new EventQueue({ clock });
        q.offer(ev("PRICE_JUMP", "A", SEVERITY.WARNING, "1"));
        expect(q.offer(ev("PRICE_JUMP", "A", SEVERITY.WARNING, "2"))).toBe("coalesced");
        expect(q.size).toBe(1);
        expect(q.health().coalesced).toBe(1);
    });

    it("returns CRITICAL before WARNING", () => {
        const q = new EventQueue({ clock });
        q.offer(ev("PRICE_JUMP", "A", SEVERITY.WARNING));
        q.offer(ev("STOP_BREACH", "B", SEVERITY.CRITICAL));
        expect(q.take().symbol).toBe("B");
    });

    it("is bounded and drops the lowest priority when full", () => {
        const q = new EventQueue({ capacity: 2, clock });
        q.offer(ev("TARGET_APPROACHING", "A", SEVERITY.INFO));
        q.offer(ev("PRICE_JUMP", "B", SEVERITY.WARNING));
        q.offer(ev("STOP_BREACH", "C", SEVERITY.CRITICAL));
        expect(q.size).toBe(2);
        expect(q.health().dropped).toBe(1);
        const symbols = q.drain().map((e) => e.symbol);
        expect(symbols).toContain("C");
        expect(symbols).not.toContain("A");
    });

    it("never displaces a more important event for a less important one", () => {
        const q = new EventQueue({ capacity: 1, clock });
        q.offer(ev("STOP_BREACH", "A", SEVERITY.CRITICAL));
        expect(q.offer(ev("TARGET_APPROACHING", "B", SEVERITY.INFO))).toBe("rejected");
        expect(q.take().symbol).toBe("A");
    });

    it("never hands out a stale event", () => {
        const q = new EventQueue({ maxAgeMs: 1000, clock });
        q.offer(ev("PRICE_JUMP", "A"));
        now += 5000;
        expect(q.take()).toBeNull();
        expect(q.health().expired).toBe(1);
    });
});

describe("orchestrator lifecycle and decision path", () => {
    const position = (over = {}) => ({
        symbol: "RELIANCE", userId: 1, side: "BUY", quantity: 10,
        entryPricePaise: 100000, currentPricePaise: 100000, exposurePaise: 1000000,
        stale: false, dataAgeMs: 1000, sessionPhase: "MID_SESSION",
        thesisId: "t-1", correlationId: "c-1", holdingSeconds: 3600,
        stopPaise: 95000, targetPaise: 110000,
        stopDistance: 1, targetDistance: 1, pnlPercent: 0,
        unrealisedPnlPaise: 0, hasThesis: true, ...over,
    });

    const build = (over = {}, clockAt = at(12, 0)) => {
        const ports = {
            loadPositions: vi.fn(async () => [position()]),
            loadPortfolio: vi.fn(async () => ({ userId: 1, grossExposurePaise: 1000000, unrealisedPnlPaise: 0 })),
            positionFor: vi.fn(async () => position({ stopDistance: -0.2 })),
            loadThesis: vi.fn(async () => ({ id: "t-1", side: "BUY", entry_price_paise: 100000 })),
            recordEvent: vi.fn(async (e) => ({ id: `ev-${e.type}` })),
            reassess: vi.fn(async () => ({ action: "EXIT", confidence: "HIGH" })),
            intentFrom: (d, p) => (d.action === "HOLD" ? null
                : { action: d.action, side: "SELL", symbol: p.symbol, quantity: p.quantity }),
            evaluateRisk: vi.fn(async () => ({ decision: "ALLOW" })),
            execute: vi.fn(async () => ({})),
            journal: vi.fn(async () => ({})),
            openOrders: vi.fn(async () => []),
            reconcileAll: vi.fn(async () => []),
            expireStaleOrders: vi.fn(async () => []),
            ...over,
        };
        return { ports, orch: new Orchestrator({ ports, clock: () => clockAt }) };
    };

    it("starts, recovers, and reports RUNNING", async () => {
        const { orch, ports } = build();
        expect(await orch.start()).toBe(true);
        expect(orch.phase).toBe(PHASE.RUNNING);
        expect(ports.openOrders).toHaveBeenCalled();
        expect(orch.health().recovery.openOrders).toBe(0);
        await orch.stop();
    });

    it("a duplicate start is a no-op", async () => {
        const { orch } = build();
        await orch.start();
        expect(await orch.start()).toBe(false);
        await orch.stop();
    });

    it("shuts down gracefully and reconciles on the way out", async () => {
        const { orch, ports } = build();
        await orch.start();
        expect(await orch.stop()).toBe(true);
        expect(orch.phase).toBe(PHASE.STOPPED);
        expect(ports.reconcileAll).toHaveBeenCalled();
        expect(await orch.stop()).toBe(false);
    });

    it("recovers ambiguous orders on start", async () => {
        const { orch } = build({
            openOrders: async () => [{ id: 1, state: "AMBIGUOUS" }, { id: 2, state: "WORKING" }],
        });
        await orch.start();
        expect(orch.health().recovery.ambiguousOrders).toBe(1);
        await orch.stop();
    });

    it("a quiet position produces zero reasoning and zero queued work", async () => {
        const { orch, ports } = build();
        await orch.monitorCycle();
        expect(orch.queue.size).toBe(0);
        await orch.reasoningCycle();
        expect(ports.reassess).not.toHaveBeenCalled();
        expect(orch.health().metrics.reasoningInvocations).toBe(0);
    });

    it("a material event queues work and invokes reasoning exactly once", async () => {
        const { orch, ports } = build({
            loadPositions: async () => [position({ stopDistance: -0.2 })],
        });
        await orch.monitorCycle();
        expect(orch.queue.size).toBe(1);
        await orch.reasoningCycle();
        expect(ports.reassess).toHaveBeenCalledOnce();
        expect(ports.execute).toHaveBeenCalledOnce();
    });

    it("an already-recorded event is not queued again", async () => {
        const { orch, ports } = build({
            loadPositions: async () => [position({ stopDistance: -0.2 })],
            recordEvent: async () => null,   // dedup hit
        });
        await orch.monitorCycle();
        expect(orch.queue.size).toBe(0);
        await orch.reasoningCycle();
        expect(ports.reassess).not.toHaveBeenCalled();
    });

    it("risk rejection prevents execution and is journaled", async () => {
        const { orch, ports } = build({
            loadPositions: async () => [position({ stopDistance: -0.2 })],
            evaluateRisk: async () => ({ decision: "REJECT", code: "POSITION_LIMIT" }),
        });
        await orch.monitorCycle();
        await orch.reasoningCycle();
        expect(ports.execute).not.toHaveBeenCalled();
        expect(orch.health().metrics.riskRejections).toBe(1);
        expect(ports.journal).toHaveBeenCalledWith(expect.objectContaining({ executed: false }));
    });

    it("HOLD produces no intent and no execution", async () => {
        const { orch, ports } = build({
            loadPositions: async () => [position({ stopDistance: -0.2 })],
            reassess: async () => ({ action: "HOLD", confidence: "LOW" }),
        });
        await orch.monitorCycle();
        await orch.reasoningCycle();
        expect(ports.execute).not.toHaveBeenCalled();
        expect(ports.journal).toHaveBeenCalled();
    });

    it("blocks a new entry in the closing window but still allows an exit", async () => {
        const closing = at(15, 25);
        const entry = build({
            loadPositions: async () => [position({ stopDistance: -0.2 })],
            reassess: async () => ({ action: "ADD", confidence: "HIGH" }),
        }, closing);
        await entry.orch.monitorCycle();
        await entry.orch.reasoningCycle();
        expect(entry.ports.execute).not.toHaveBeenCalled();

        const exit = build({ loadPositions: async () => [position({ stopDistance: -0.2 })] }, closing);
        await exit.orch.monitorCycle();
        await exit.orch.reasoningCycle();
        expect(exit.ports.execute).toHaveBeenCalledOnce();
    });

    it("runs no reasoning job outside permitted sessions", async () => {
        const { orch } = build({}, at(20, 0));   // CLOSED
        await orch.start();
        const result = await orch.scheduler.runJobOnce("reasoning");
        expect(result.skipped).toBe("not-permitted");
        await orch.stop();
    });

    it("keeps monitoring and reconciling when the market is closed", async () => {
        const { orch } = build({}, at(20, 0));
        await orch.start();
        expect((await orch.scheduler.runJobOnce("position-monitor")).ok).toBe(true);
        expect((await orch.scheduler.runJobOnce("reconciliation")).ok).toBe(true);
        await orch.stop();
    });

    it("a reasoning failure is isolated and counted, not fatal", async () => {
        const { orch } = build({
            loadPositions: async () => [position({ stopDistance: -0.2 })],
            reassess: async () => { throw new Error("llm exploded"); },
        });
        await orch.monitorCycle();
        await expect(orch.reasoningCycle()).resolves.toBeDefined();
        expect(orch.health().metrics.errors).toBe(1);
    });

    it("halting stops all trading while keeping the loop alive", async () => {
        const { orch, ports } = build({ loadPositions: async () => [position({ stopDistance: -0.2 })] });
        orch.setHalted(true, "manual");
        expect(orch.session()).toBe(SESSION.HALTED);
        await orch.monitorCycle();
        await orch.reasoningCycle();
        expect(ports.execute).not.toHaveBeenCalled();
    });

    it("exposes health covering phase, session, queue, scheduler and metrics", async () => {
        const { orch } = build();
        await orch.start();
        const h = orch.health();
        expect(h.phase).toBe(PHASE.RUNNING);
        expect(h.session).toBe(SESSION.OPEN);
        // position-monitor, reasoning, reconciliation, pending-sweep, order-expiry
        expect(h.scheduler.jobCount).toBe(5);
        expect(h.queue).toHaveProperty("depth");
        expect(h.metrics).toHaveProperty("reasoningAvoided");
        await orch.stop();
    });

    // The engine absorbs a repeat of an intent it has already seen and reports
    // it. Ignoring that flag recorded a trade that did not happen: a second
    // REDUCE on one thesis derives the same client order id, so nothing is
    // placed, and the journal said executed anyway.
    it("does not report a suppressed duplicate as an execution", async () => {
        const { orch, ports } = build({
            reassess: async () => ({ action: "REDUCE", confidence: "HIGH" }),
            execute: vi.fn(async () => ({ order: { id: 1, state: "FILLED" }, duplicate: true })),
        });
        const outcome = await orch.handleEvent(
            { type: "STOP_APPROACHING", severity: "WARNING", symbol: "RELIANCE",
              thesisId: "t-1", storedId: "ev-1" }, "c-1", SESSION.OPEN);

        expect(ports.execute).toHaveBeenCalled();
        expect(outcome.executed).toBe(false);
        expect(outcome.blocked).toBe("duplicate intent");
        expect(orch.metrics.executions).toBe(0);
        expect(orch.metrics.duplicatesSuppressed).toBe(1);
        expect(ports.journal).toHaveBeenCalledWith(
            expect.objectContaining({ executed: false }));
    });

    it("reports a real execution as one", async () => {
        const { orch, ports } = build({
            execute: vi.fn(async () => ({ order: { id: 2, state: "FILLED" }, duplicate: false })),
        });
        const outcome = await orch.handleEvent(
            { type: "STOP_APPROACHING", severity: "WARNING", symbol: "RELIANCE",
              thesisId: "t-1", storedId: "ev-2" }, "c-2", SESSION.OPEN);
        expect(outcome.executed).toBe(true);
        expect(orch.metrics.executions).toBe(1);
        expect(orch.metrics.duplicatesSuppressed).toBe(0);
    });

    // Every decision on one position carries the thesis's correlation id, so
    // the record needs an identity of its own or only the first survives.
    it("gives every decision its own identity", async () => {
        const { orch, ports } = build({
            reassess: async () => ({ action: "HOLD", confidence: "LOW" }),
        });
        for (const storedId of ["ev-a", "ev-b"]) {
            await orch.handleEvent(
                { type: "STOP_APPROACHING", severity: "WARNING", symbol: "RELIANCE",
                  thesisId: "t-1", storedId },
                "same-correlation", SESSION.OPEN);
        }
        const ids = ports.journal.mock.calls.map(([entry]) => entry.decisionId);
        expect(ids).toHaveLength(2);
        expect(ids[0]).toBeTruthy();
        expect(ids[0]).not.toBe(ids[1]);
        // The correlation still ties them together.
        for (const [entry] of ports.journal.mock.calls) {
            expect(entry.correlationId).toBe("same-correlation");
        }
    });

    it("propagates a correlation id from event through to execution", async () => {
        const { orch, ports } = build({ loadPositions: async () => [position({ stopDistance: -0.2 })] });
        await orch.monitorCycle();
        await orch.reasoningCycle();
        const intent = ports.execute.mock.calls[0][0];
        expect(intent.correlationId).toBeDefined();
        expect(ports.journal).toHaveBeenCalledWith(
            expect.objectContaining({ correlationId: intent.correlationId, executed: true }));
    });

    it("does not duplicate an action when the same cycle runs twice", async () => {
        const { orch, ports } = build({ loadPositions: async () => [position({ stopDistance: -0.2 })] });
        await orch.monitorCycle();
        await orch.monitorCycle();   // same event key, already seen
        await orch.reasoningCycle();
        await orch.reasoningCycle();
        expect(ports.execute).toHaveBeenCalledOnce();
    });
});

// A candidate the analyser declined to reason about is not a decision.
//
// runtime.handleCandidate returns {skipped} for a symbol on cooldown, for
// discovery running ahead of its budget pace, and for a symbol another pass
// already holds. The orchestrator journalled those as decisions: rows with no
// thesis, no evidence, no challenge and an action of NONE. In one live session
// 43 of 65 records were that, the day's decision tally read 53 against 22 real
// decisions, and the reasoning count read 57 against 18 actual model runs.

describe("a skipped candidate is not recorded as a decision", () => {
    const candidateEvent = { type: "VOLUME_SPIKE", severity: "CRITICAL",
                             symbol: "RELIANCE", storedId: "ev-skip" };

    const buildCandidate = (analyseCandidate) => {
        const ports = {
            loadPositions: vi.fn(async () => []),
            loadPortfolio: vi.fn(async () => ({ userId: 1, cashPaise: 100_000_000 })),
            recordEvent: vi.fn(async (e) => ({ id: `ev-${e.type}` })),
            analyseCandidate: vi.fn(analyseCandidate),
            journal: vi.fn(async () => ({})),
            openOrders: vi.fn(async () => []),
            reconcileAll: vi.fn(async () => []),
            expireStaleOrders: vi.fn(async () => []),
        };
        return { ports, orch: new Orchestrator({ ports, clock: () => at(12, 0) }) };
    };

    it("writes no journal entry when the analyser declines", async () => {
        const { orch, ports } = buildCandidate(
            async () => ({ skipped: "reasoned about recently; nothing new to price" }));
        orch.lastContexts = { RELIANCE: { price: 1000 } };

        const outcome = await orch.handleEvent(candidateEvent, "anom-RELIANCE", SESSION.OPEN);

        expect(outcome).toEqual({
            route: "CANDIDATE", skipped: "reasoned about recently; nothing new to price" });
        expect(ports.journal).not.toHaveBeenCalled();
    });

    it("does not count a skip as a reasoning invocation", async () => {
        const { orch } = buildCandidate(async () => ({ skipped: "spending ahead of pace" }));
        orch.lastContexts = { RELIANCE: { price: 1000 } };

        await orch.handleEvent(candidateEvent, "anom-RELIANCE", SESSION.OPEN);

        expect(orch.metrics.reasoningInvocations).toBe(0);
        expect(orch.metrics.reasoningSkipped).toBe(1);
    });

    it("says the trader went back to watching, and why", async () => {
        const narrated = [];
        const { orch } = buildCandidate(async () => ({ skipped: "symbol already being reasoned about" }));
        orch.narrator = { emit: (kind, payload) => narrated.push({ kind, payload }) };
        orch.lastContexts = { RELIANCE: { price: 1000 } };

        await orch.handleEvent(candidateEvent, "anom-RELIANCE", SESSION.OPEN);

        const finished = narrated.find((n) => n.kind === "REASONING_FINISHED");
        expect(finished.payload.skipped).toBe("symbol already being reasoned about");
        expect(finished.payload.action).toBeNull();
    });

    it("still records a candidate that was genuinely reasoned about", async () => {
        const { orch, ports } = buildCandidate(async () => ({
            action: "HOLD", confidence: "LOW", reasoning: "no edge here", evidence: [] }));
        orch.lastContexts = { RELIANCE: { price: 1000 } };

        const outcome = await orch.handleEvent(candidateEvent, "anom-RELIANCE", SESSION.OPEN);

        expect(outcome).toMatchObject({ action: "HOLD", executed: false });
        expect(orch.metrics.reasoningInvocations).toBe(1);
        expect(orch.metrics.reasoningSkipped).toBe(0);
        expect(ports.journal).toHaveBeenCalledWith(
            expect.objectContaining({ decision: expect.objectContaining({ action: "HOLD" }) }));
    });

    it("does not journal twice when the runtime already did", async () => {
        const { orch, ports } = buildCandidate(async () => ({
            action: "BUY", executed: true, journaled: true }));
        orch.lastContexts = { RELIANCE: { price: 1000 } };

        await orch.handleEvent(candidateEvent, "anom-RELIANCE", SESSION.OPEN);
        expect(ports.journal).not.toHaveBeenCalled();
        expect(orch.metrics.reasoningInvocations).toBe(1);
    });
});
