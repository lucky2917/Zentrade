import { randomUUID } from "node:crypto";
import { Scheduler } from "./scheduler.js";
import { EventQueue } from "./eventQueue.js";
import { SESSION, sessionStateAt, permits } from "./session.js";
import { runMonitorCycle } from "../autonomous/monitor.js";
import { requiresReasoning, routeOf, ROUTE } from "../autonomous/events.js";
import { observeUniverse } from "../intelligence/observe.js";
import { buildMarketState, UNKNOWN_MARKET } from "../intelligence/marketState.js";
import { revalidate, VERDICT } from "../execution/revalidate.js";
import { positionIntentKey } from "../autonomous/symbolGate.js";

// The autonomous orchestrator.
//
// Owns the lifecycle: initialise -> recover -> reconcile -> run -> shut down.
// It contains no market knowledge and no reasoning of its own; it decides WHEN
// work runs and enforces the session policy around it. All ports are injected,
// so the whole loop is drivable from a test with a fixed clock.
//
// The AI never reaches execution from here: reasoning produces an intent, the
// risk gate approves it, and only then does the Phase 1 engine run.

export const PHASE = {
    STOPPED: "STOPPED", INITIALISING: "INITIALISING", RECOVERING: "RECOVERING",
    RUNNING: "RUNNING", DRAINING: "DRAINING",
};

export const DEFAULT_INTERVALS = {
    positionMonitorMs: 15_000,
    reasoningMs: 5_000,
    reconciliationMs: 60_000,
    expiryMs: 60_000,
};

export class Orchestrator {
    constructor({ ports, intervals = {}, clock = () => new Date(), logger = null } = {}) {
        this.ports = ports;
        this.intervals = { ...DEFAULT_INTERVALS, ...intervals };
        this.clock = clock;
        this.logger = logger;
        this.phase = PHASE.STOPPED;
        this.halted = false;
        this.queue = new EventQueue({ clock: () => this.clock().getTime() });
        this.scheduler = new Scheduler({ clock, logger });
        this.previousBySymbol = new Map();
        this.lastContexts = {};
        // Market-wide state is context for every decision, not an event to
        // route. It was detected and discarded before.
        this.marketState = UNKNOWN_MARKET;
        this.metrics = {
            cycles: 0, eventsEmitted: 0, eventsQueued: 0,
            reasoningInvocations: 0, reasoningAvoided: 0,
            riskRejections: 0, executions: 0, errors: 0,
            anomaliesDetected: 0, marketWideAnomalies: 0,
            newsEventsReceived: 0, newsEventsDeduplicated: 0, eventsReleased: 0,
            lastMarketUpdateAt: null, lastDecisionAt: null, lastExecutionAt: null,
        };
        this.recovery = null;
        this.registerJobs();
    }

    session() { return sessionStateAt(this.clock(), { halted: this.halted }); }

    registerJobs() {
        this.scheduler.register({
            name: "position-monitor",
            intervalMs: this.intervals.positionMonitorMs,
            shouldRun: () => permits(this.session(), "positionMonitor"),
            run: () => this.monitorCycle(),
        });
        this.scheduler.register({
            name: "reasoning",
            intervalMs: this.intervals.reasoningMs,
            shouldRun: () => permits(this.session(), "reasoning"),
            run: () => this.reasoningCycle(),
        });
        this.scheduler.register({
            name: "reconciliation",
            intervalMs: this.intervals.reconciliationMs,
            shouldRun: () => permits(this.session(), "reconciliation"),
            run: () => this.reconciliationCycle(),
        });
        this.scheduler.register({
            name: "order-expiry",
            intervalMs: this.intervals.expiryMs,
            shouldRun: () => permits(this.session(), "reconciliation"),
            run: () => this.ports.expireStaleOrders?.(this.clock()) ?? [],
        });
    }

    // ---- lifecycle ------------------------------------------------------

    async start() {
        if (this.phase === PHASE.RUNNING) return false;
        this.phase = PHASE.INITIALISING;
        this.phase = PHASE.RECOVERING;
        this.recovery = await this.recover();
        this.scheduler.start();
        this.phase = PHASE.RUNNING;
        this.logger?.info?.("Orchestrator", "autonomous loop started", {
            session: this.session(), recovered: this.recovery,
        });
        return true;
    }

    async stop() {
        if (this.phase === PHASE.STOPPED) return false;
        this.phase = PHASE.DRAINING;
        await this.scheduler.stop();
        // A final reconciliation so a restart does not begin from an unknown
        // execution state.
        try { await this.reconciliationCycle(); } catch (err) {
            this.logger?.error?.("Orchestrator", "shutdown reconciliation failed",
                                 { error: err.message });
        }
        this.phase = PHASE.STOPPED;
        return true;
    }

    // Restart safety comes from Phase 1: orders, fills and positions live in
    // Postgres, and event keys are deterministic. Recovery reads that state
    // rather than replaying actions.
    async recover() {
        const openOrders = (await this.ports.openOrders?.()) ?? [];
        const positions = (await this.ports.loadPositions?.()) ?? [];
        const ambiguous = openOrders.filter((o) => o.state === "AMBIGUOUS");
        this.previousBySymbol = new Map();

        // Work raised before the restart and never completed. Without this the
        // queue was memory-only: a crash between persisting an event and
        // reasoning about it lost the condition permanently.
        const pending = (await this.ports.loadPendingEvents?.()) ?? [];
        const now = this.clock().getTime();
        let requeued = 0;
        for (const event of pending) {
            const outcome = this.queue.offer(event, now);
            if (outcome === "admitted" || outcome === "coalesced") requeued += 1;
        }

        return {
            openOrders: openOrders.length,
            ambiguousOrders: ambiguous.length,
            positions: positions.length,
            pendingEvents: pending.length,
            requeuedEvents: requeued,
            at: this.clock().toISOString(),
        };
    }

    // ---- cycles ---------------------------------------------------------

    async monitorCycle() {
        const now = this.clock();
        const positions = (await this.ports.loadPositions?.()) ?? [];
        const portfolio = await this.ports.loadPortfolio?.();
        this.metrics.lastMarketUpdateAt = now.toISOString();

        const events = runMonitorCycle({
            positions, portfolio, previousBySymbol: this.previousBySymbol, now,
        });

        // Phase 4 intelligence over the observed universe. Position monitoring
        // answers "has this position crossed a level"; this answers "is
        // something unusual happening", which is a different question and
        // covers symbols we do not yet hold.
        if (this.ports.loadObservations) {
            const raw = await this.ports.loadObservations();
            // Attach the thesis for symbols we hold, so an anomaly on a held
            // position routes to reassessment while the same anomaly on an
            // unheld symbol routes to candidate analysis.
            const thesisBySymbol = new Map(
                positions.filter((p) => p.thesisId).map((p) => [p.symbol, p.thesisId]));
            const observations = raw.map((o) => ({
                ...o, thesisId: o.thesisId ?? thesisBySymbol.get(o.symbol) ?? null,
            }));
            const universe = observeUniverse({
                observations, asOf: now, calculatedAt: now });
            this.metrics.anomaliesDetected += universe.events.length;
            if (universe.marketWide) this.metrics.marketWideAnomalies += 1;
            this.lastContexts = universe.contexts;
            this.marketState = buildMarketState({ moves: universe.moves, asOf: now });
            events.push(...universe.events);
        }

        // External events (news) already carry their own identity and PIT
        // boundary; they join the same queue as everything else.
        if (this.ports.pendingNewsEvents) {
            const newsEvents = await this.ports.pendingNewsEvents(now);
            this.metrics.newsEventsReceived += newsEvents.length;
            events.push(...newsEvents);
        }

        for (const event of events) {
            this.metrics.eventsEmitted += 1;
            const candidateWorthy = routeOf(event) === ROUTE.CANDIDATE
                && this.ports.analyseCandidate
                && (event.severity === "WARNING" || event.severity === "CRITICAL");
            if (!requiresReasoning(event) && !candidateWorthy) {
                this.metrics.reasoningAvoided += 1;
                await this.ports.recordEvent?.(event);
                continue;
            }
            // Persist first. A row already HANDLED returns nothing, which is
            // real deduplication; a row still PENDING is refreshed and offered
            // again, so a condition dropped by the queue is not lost.
            const stored = await this.ports.recordEvent?.(event);
            if (!stored) continue;
            const durable = { ...event, storedId: stored.id ?? null,
                              severity: stored.severity ?? event.severity };
            const outcome = this.queue.offer(durable, now.getTime());
            if (outcome === "admitted" || outcome === "coalesced") this.metrics.eventsQueued += 1;
        }

        for (const p of positions) this.previousBySymbol.set(p.symbol, p);
        this.metrics.cycles += 1;
        return { events: events.length, queued: this.queue.size };
    }

    // Tier 3. Only runs against queued events, so a quiet market produces no
    // LLM calls at all.
    async reasoningCycle({ limit = 3 } = {}) {
        const session = this.session();
        const events = this.queue.drain(limit);
        const handled = [];

        for (const event of events) {
            const correlationId = event.correlationId ?? `auto-${randomUUID()}`;
            try {
                handled.push(await this.handleEvent(event, correlationId, session));
                // Only now is the condition genuinely dealt with. Marking it
                // earlier is what allowed a crash mid-reasoning to lose it.
                await this.ports.markEventHandled?.(event.storedId);
            } catch (err) {
                this.metrics.errors += 1;
                this.logger?.error?.("Orchestrator", "event handling failed",
                                     { error: err.message, event: event.type });
                await this.ports.markEventFailed?.(event.storedId, err.message);
            }
        }

        // Anything the queue could not hold goes back to the durable store as
        // pending rather than disappearing.
        const released = this.queue.drainReleased();
        for (const event of released) {
            await this.ports.markEventFailed?.(event.storedId, "released by the queue");
        }
        if (released.length) this.metrics.eventsReleased += released.length;
        return handled;
    }

    async handleEvent(event, correlationId, session) {
        const route = routeOf(event);

        // A candidate is a different question from a position: "is this worth
        // entering" rather than "is the thesis still valid". It gets its own
        // path, and it still cannot execute without passing risk.
        if (route === ROUTE.CANDIDATE) {
            if (!this.ports.analyseCandidate) return { skipped: "no candidate analyser" };
            if (!permits(session, "discovery")) return { skipped: "session forbids discovery" };

            // The context computed in this cycle's observation pass. Without it
            // the candidate path has no price, so it could only ever spend
            // reasoning calls to arrive at "no usable price for sizing".
            const context = this.lastContexts?.[event.symbol] ?? null;
            if (!context || !Number.isFinite(context.price)) {
                this.metrics.reasoningAvoided += 1;
                return { route: ROUTE.CANDIDATE, skipped: "no observed context for symbol" };
            }

            this.metrics.reasoningInvocations += 1;
            const analysis = await this.ports.analyseCandidate({
                symbol: event.symbol, event, context, market: this.marketState,
                reasons: [`${event.type} (${event.severity}): ${event.reason}`],
            });
            // The executing path journals its own decision, risk verdict and
            // outcome; recording it again here logged one decision twice. A
            // plain analyser port does not, so it is still recorded.
            if (!analysis?.journaled) {
                await this.ports.journal?.({ correlationId, event, decision: analysis,
                                             risk: null, route: ROUTE.CANDIDATE,
                                             executed: Boolean(analysis?.executed) });
            }
            return { route: ROUTE.CANDIDATE, action: analysis?.action ?? null,
                     executed: Boolean(analysis?.executed) };
        }

        if (route !== ROUTE.POSITION) return { skipped: "not a position event" };

        const position = (await this.ports.positionFor?.(event.symbol)) ?? null;
        if (!position) return { skipped: "position gone" };
        const thesis = (await this.ports.loadThesis?.(position)) ?? null;
        if (!thesis) return { skipped: "no thesis" };

        this.metrics.reasoningInvocations += 1;
        const decision = await this.ports.reassess({
            position, thesis, event,
            marketState: this.lastContexts?.[event.symbol] ?? null,
            market: this.marketState,
        });
        this.metrics.lastDecisionAt = this.clock().toISOString();

        const built = this.ports.intentFrom(decision, position);
        // One thesis gets one exit, however many events argue for it.
        const intent = built ? {
            ...built,
            clientOrderId: positionIntentKey({
                thesisId: thesis?.id ?? null, action: built.action,
                symbol: event.symbol, at: this.clock() }),
        } : null;
        if (!intent) {
            await this.persistReassessment({ position, thesis, event, decision, risk: null,
                                             correlationId, executed: false });
            await this.ports.journal?.({ correlationId, event, decision, risk: null, executed: false });
            return { action: decision.action, executed: false };
        }

        // Session policy is a hard gate, checked before risk: an exit is still
        // permitted in the closing window, a new entry is not.
        const reducing = ["EXIT", "REDUCE"].includes(decision.action);
        const capability = reducing ? "exits" : "newExposure";
        if (!permits(session, capability)) {
            await this.ports.journal?.({
                correlationId, event, decision, risk: null, executed: false,
                blocked: `session ${session} does not permit ${capability}`,
            });
            return { action: decision.action, executed: false, blocked: capability };
        }

        // Tier 4 on the position path. An exit is never blocked by drift, but
        // it is re-priced to the market and sized to what is actually held.
        const observation = {
            pricePaise: position.currentPricePaise,
            atMs: this.clock().getTime() - (position.dataAgeMs ?? 0),
            tickSeq: null,
        };
        const world = (await this.ports.currentWorld?.(event.symbol)) ?? {
            nowMs: this.clock().getTime(),
            pricePaise: position.currentPricePaise,
            priceAgeMs: position.dataAgeMs ?? 0,
            position: { quantity: position.quantity },
        };
        const check = revalidate({ intent, observation, world });
        if (check.verdict === VERDICT.REJECT) {
            await this.persistReassessment({ position, thesis, event, decision, risk: null,
                                             correlationId, executed: false });
            await this.ports.journal?.({
                correlationId, event, decision, risk: null, executed: false,
                blocked: `revalidation ${check.code}: ${check.reason}` });
            return { action: decision.action, executed: false, blocked: check.code };
        }
        const revalidated = check.intent;

        const risk = await this.ports.evaluateRisk({ ...revalidated, correlationId }, position);
        if (risk.decision !== "ALLOW") {
            this.metrics.riskRejections += 1;
            await this.persistReassessment({ position, thesis, event, decision, risk,
                                             correlationId, executed: false });
            await this.ports.journal?.({ correlationId, event, decision, risk, executed: false });
            return { action: decision.action, executed: false, risk: risk.code };
        }

        await this.ports.execute({ ...revalidated, correlationId });
        this.metrics.executions += 1;
        this.metrics.lastExecutionAt = this.clock().toISOString();
        await this.persistReassessment({ position, thesis, event, decision, risk,
                                         correlationId, executed: true });
        await this.ports.journal?.({ correlationId, event, decision, risk, executed: true });
        return { action: decision.action, executed: true };
    }

    // Every reassessment is persisted against its thesis, executed or not.
    // A decision that leaves no record cannot be audited later, and "why did
    // it hold?" is as important a question as "why did it sell?".
    async persistReassessment({ position, thesis, event, decision, risk, correlationId, executed }) {
        if (!this.ports.recordReassessment || !thesis?.id) return null;
        try {
            return await this.ports.recordReassessment({
                thesisId: thesis.id, eventId: event?.storedId ?? null, correlationId,
                action: decision.action, confidence: decision.confidence,
                thesisStillValid: decision.thesisStillValid ?? true,
                whatChanged: decision.whatChanged ?? "unspecified",
                material: decision.material ?? false,
                reasoning: decision.reasoning ?? "no reasoning supplied",
                evidence: decision.evidence ?? [],
                unrealisedPnlPaise: position.unrealisedPnlPaise ?? 0,
                currentPricePaise: position.currentPricePaise ?? 0,
                holdingSeconds: position.holdingSeconds ?? 0,
                riskDecision: risk?.decision ?? null, riskReason: risk?.reason ?? null,
                executed,
            });
        } catch (err) {
            this.logger?.error?.("Orchestrator", "reassessment not persisted",
                                 { error: err.message });
            return null;
        }
    }

    async reconciliationCycle() {
        if (!this.ports.reconcileAll) return { reconciled: 0 };
        const results = await this.ports.reconcileAll();
        return { reconciled: results.length, results };
    }

    // ---- observability --------------------------------------------------

    setHalted(halted, reason = null) {
        this.halted = halted;
        this.logger?.warn?.("Orchestrator", `halted=${halted}`, { reason });
    }

    health() {
        return {
            phase: this.phase,
            session: this.session(),
            halted: this.halted,
            recovery: this.recovery,
            queue: this.queue.health(),
            contexts: Object.keys(this.lastContexts ?? {}).length,
            market: this.marketState,
            scheduler: this.scheduler.health(),
            metrics: { ...this.metrics },
        };
    }
}
