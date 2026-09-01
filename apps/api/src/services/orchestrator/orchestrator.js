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
import { KIND } from "../cockpit/narrator.js";
import { narrateDecision, decisionCard } from "../cockpit/reasoningNarration.js";

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
    pendingSweepMs: 30_000,
};

// How much reasoning may be in flight at once.
//
// Sequential reasoning made the cycle, not the batch, the bottleneck: three
// events at roughly two model calls each took longer than the interval, so the
// job spent the open skipping itself while the queue expired work at sixty
// seconds and re-offered it forever.
//
// Concurrency is deliberately small. Each chain issues two sequential model
// calls, so this is also the ceiling on simultaneous requests to the model
// provider, and exceeding its rate limit turns a burst into a retry storm.
// Sized to the MODEL budget, not picked. Each decision costs two sequential
// model calls, so a batch of 3 is 6 calls a cycle; against a 20/minute model
// ceiling that is roughly a cycle every 18 seconds, and the scheduler skips the
// intervening ticks because a job never overlaps itself. Demand therefore
// matches supply instead of queueing 140 calls a minute at a provider that
// answers 429.
export const DEFAULT_REASONING = { batch: 2, concurrency: 1 };

export class Orchestrator {
    constructor({ ports, intervals = {}, reasoning = {},
                  clock = () => new Date(), logger = null, narrator = null } = {}) {
        this.ports = ports;
        // Optional by design: the loop runs identically without a cockpit
        // attached, and narration can never change a decision.
        this.narrator = narrator;
        this.intervals = { ...DEFAULT_INTERVALS, ...intervals };
        this.reasoning = { ...DEFAULT_REASONING, ...reasoning };
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
            reasoningInvocations: 0, reasoningAvoided: 0, reasoningBatches: 0,
            reasoningSkipped: 0,
            maxReasoningConcurrency: 0,
            riskRejections: 0, executions: 0, errors: 0, duplicatesSuppressed: 0,
            anomaliesDetected: 0, marketWideAnomalies: 0,
            newsEventsReceived: 0, newsEventsDeduplicated: 0, eventsReleased: 0,
            lastMarketUpdateAt: null, lastDecisionAt: null, lastExecutionAt: null,
            eventsReclaimed: 0,
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
        // The durable store's other half. recover() reads unfinished work at
        // startup; this reads it while running, so a condition the queue had to
        // drop comes back in the same session rather than at the next restart.
        this.scheduler.register({
            name: "pending-sweep",
            intervalMs: this.intervals.pendingSweepMs,
            shouldRun: () => permits(this.session(), "reasoning"),
            run: () => this.sweepPendingEvents(),
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
        const at = this.clock();
        const openOrders = (await this.ports.openOrders?.()) ?? [];
        const positions = (await this.ports.loadPositions?.(at)) ?? [];
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
        // G4. One instant for the whole cycle. Every read below is bound to it,
        // so the positions, the portfolio and the observed universe describe the
        // same moment rather than three moments a few hundred milliseconds apart.
        const now = this.clock();
        const positions = (await this.ports.loadPositions?.(now)) ?? [];
        const portfolio = await this.ports.loadPortfolio?.(now);
        this.metrics.lastMarketUpdateAt = now.toISOString();

        const events = runMonitorCycle({
            positions, portfolio, previousBySymbol: this.previousBySymbol, now,
        });

        // Phase 4 intelligence over the observed universe. Position monitoring
        // answers "has this position crossed a level"; this answers "is
        // something unusual happening", which is a different question and
        // covers symbols we do not yet hold.
        if (this.ports.loadObservations) {
            const raw = await this.ports.loadObservations(now);
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
            // Hand the bar-scale baselines to the tick path so deviation and
            // volume are judged continuously rather than once per sweep.
            this.ports.syncBaselines?.(universe.contexts);
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
            // Reasoning is a finite budget, not a free operation: each decision
            // costs two model calls, and a day's token allowance buys tens of
            // them, not hundreds. A WARNING on a name we do not hold is the
            // weakest thing that can ask for the brain's attention, and there
            // are hundreds of them a session.
            //
            // Held positions are unaffected — a WARNING on something we own
            // still wakes the brain, because that is a question about capital
            // already at risk. This only raises the bar for DISCOVERY.
            const candidateWorthy = routeOf(event) === ROUTE.CANDIDATE
                && this.ports.analyseCandidate
                && event.severity === "CRITICAL";
            const material = requiresReasoning(event) || candidateWorthy;

            this.narrate(event.type === "NEWS_EVENT" ? KIND.NEWS_EVENT : KIND.MARKET_EVENT, {
                symbol: event.symbol, type: event.type, severity: event.severity,
                reason: event.reason, route: routeOf(event),
                observed: event.observed ?? null, thesisId: event.thesisId ?? null,
            });
            // Why it matters, or why it does not. An operator should never have
            // to guess why the brain stayed asleep.
            this.narrate(KIND.MATERIALITY, {
                symbol: event.symbol, type: event.type, severity: event.severity,
                material,
                verdict: material ? "reasoning required" : "recorded, no reasoning",
                because: material
                    ? `${event.severity} on a ${routeOf(event).toLowerCase()} route`
                    : `${event.severity} ${routeOf(event).toLowerCase()} event does not meet the threshold`,
            });

            if (!material) {
                this.metrics.reasoningAvoided += 1;
                await this.ports.recordEvent?.(event);
                continue;
            }
            // Persist first. A row already HANDLED returns nothing, which is
            // real deduplication; a row still PENDING is refreshed and offered
            // again, so a condition dropped by the queue is not lost.
            const stored = await this.ports.recordEvent?.(event);
            if (!stored) continue;
            // How much opportunity this event carries, so the queue can serve
            // the strongest first rather than the earliest. Every anomaly is
            // raised CRITICAL, so without this they all tie and arrival order
            // decides which ones expire.
            const observed = this.lastContexts?.[event.symbol] ?? null;
            const move = observed?.mtf?.change5m ?? observed?.mtf?.change1m ?? null;
            const durable = { ...event, storedId: stored.id ?? null,
                              severity: stored.severity ?? event.severity,
                              strength: Number.isFinite(move) ? Math.abs(move) * 100 : 0 };
            const outcome = this.queue.offer(durable, now.getTime());
            if (outcome === "admitted" || outcome === "coalesced") this.metrics.eventsQueued += 1;
        }

        for (const p of positions) this.previousBySymbol.set(p.symbol, p);
        this.metrics.cycles += 1;

        // One line per observation pass, carrying real measured state. This is
        // the "quiet market" heartbeat: it says the system looked and found
        // nothing, which is different from the system not looking.
        this.narrate(KIND.MARKET_OBSERVATION, {
            session: this.session(),
            positions: positions.length,
            observed: Object.keys(this.lastContexts ?? {}).length,
            eventsRaised: events.length,
            queueDepth: this.queue.size,
            market: this.marketState,
        });

        return { events: events.length, queued: this.queue.size };
    }

    // Unfinished work that nobody is holding, offered back to the queue.
    //
    // An event the queue expired or dropped at capacity was returned to the
    // store as PENDING and then waited for a restart, because that was the only
    // thing that ever read it back. Coalescing means re-offering something
    // already queued is harmless.
    async sweepPendingEvents() {
        if (!this.ports.claimPendingEvents) return { reclaimed: 0 };
        const pending = await this.ports.claimPendingEvents({ limit: this.reasoning.batch * 10 });
        if (!pending.length) return { reclaimed: 0 };

        const now = this.clock().getTime();
        let requeued = 0;
        for (const event of pending) {
            const outcome = this.queue.offer(event, now);
            if (outcome === "admitted" || outcome === "coalesced") requeued += 1;
        }
        this.metrics.eventsReclaimed += requeued;
        this.logger?.info?.("Orchestrator", "returned unfinished work to the queue",
                            { found: pending.length, requeued });
        return { reclaimed: requeued, found: pending.length };
    }

    // Tier 3. Only runs against queued events, so a quiet market produces no
    // LLM calls at all.
    //
    // Events for different symbols are reasoned about concurrently; events for
    // the SAME symbol stay strictly sequential, because two workers holding the
    // same position would each form a view of it and each propose an exit.
    async reasoningCycle({ limit = this.reasoning.batch,
                           concurrency = this.reasoning.concurrency } = {}) {
        const session = this.session();
        const events = this.queue.drain(limit);
        const handled = [];

        // Held for the length of this pass. Without the lease the sweep above
        // would hand a condition already being reasoned about to a second
        // worker; with it, a process that dies mid-decision releases the work
        // when the lease runs out instead of losing it.
        if (events.length) {
            await this.ports.leaseEvents?.(events.map((e) => e.storedId));
        }

        if (events.length) {
            this.metrics.reasoningBatches += 1;
            const chains = this.chainBySymbol(events);
            const results = new Array(chains.length);
            const workers = Math.max(1, Math.min(concurrency, chains.length));
            this.metrics.maxReasoningConcurrency =
                Math.max(this.metrics.maxReasoningConcurrency, workers);

            let next = 0;
            const worker = async () => {
                while (next < chains.length) {
                    const index = next;
                    next += 1;
                    results[index] = await this.runChain(chains[index], session);
                }
            };
            await Promise.all(Array.from({ length: workers }, worker));
            // Flattened in chain order so the outcome does not depend on which
            // worker happened to finish first.
            for (const chain of results) handled.push(...chain);
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

    // One chain per symbol, preserving the order the queue handed them out.
    chainBySymbol(events) {
        const bySymbol = new Map();
        for (const event of events) {
            const key = event.symbol ?? "PORTFOLIO";
            const chain = bySymbol.get(key);
            if (chain) chain.push(event); else bySymbol.set(key, [event]);
        }
        return [...bySymbol.values()];
    }

    async runChain(events, session) {
        const handled = [];
        for (const event of events) handled.push(await this.handleOne(event, session));
        return handled;
    }

    // A failing event must not abandon the rest of its chain, and must leave
    // the durable row PENDING so the condition comes back rather than vanishing.
    async handleOne(event, session) {
        const correlationId = event.correlationId ?? `auto-${randomUUID()}`;
        try {
            const outcome = await this.handleEvent(event, correlationId, session);
            // Only now is the condition genuinely dealt with. Marking it
            // earlier is what allowed a crash mid-reasoning to lose it.
            await this.ports.markEventHandled?.(event.storedId);
            return outcome;
        } catch (err) {
            this.metrics.errors += 1;
            this.logger?.error?.("Orchestrator", "event handling failed",
                                 { error: err.message, event: event.type });
            await this.ports.markEventFailed?.(event.storedId, err.message);
            return { error: err.message, type: event.type, symbol: event.symbol };
        }
    }

    async handleEvent(event, correlationId, session) {
        const route = routeOf(event);

        // One decision, one identity. The correlation id belongs to the THREAD
        // — a position's reassessments all share the thesis's — so it cannot
        // also be what a record is deduplicated on.
        const decisionId = randomUUID();
        const record = (fields) => this.ports.journal?.({
            decisionId, correlationId, event, ...fields });
        // The decision's instant. Every read that forms this decision uses it;
        // only the Tier 4 revalidation below deliberately takes a fresh one,
        // because revalidating against the decision's own timestamp would
        // revalidate nothing.
        const asOf = this.clock();

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

            this.narrate(KIND.REASONING_STARTED, {
                symbol: event.symbol, route: ROUTE.CANDIDATE, trigger: event.type,
                correlationId, severity: event.severity, because: event.reason,
            });
            const analysis = await this.ports.analyseCandidate({
                symbol: event.symbol, event, context, market: this.marketState, asOf,
                reasons: [`${event.type} (${event.severity}): ${event.reason}`],
            });

            // The analyser may decline to reason at all — the symbol is on
            // cooldown, discovery is ahead of its budget pace, another pass
            // holds the symbol. That is not a decision, and writing it as one
            // filled the record with rows carrying no thesis, no evidence, no
            // challenge and an action of NONE, while inflating both the
            // reasoning count and the day's decision tally.
            if (analysis?.skipped) {
                this.metrics.reasoningSkipped += 1;
                this.narrate(KIND.REASONING_FINISHED, {
                    symbol: event.symbol, route: ROUTE.CANDIDATE, correlationId,
                    action: null, executed: false,
                    skipped: analysis.skipped,
                    holdingPositions: this.previousBySymbol.size > 0,
                });
                return { route: ROUTE.CANDIDATE, skipped: analysis.skipped };
            }

            this.metrics.reasoningInvocations += 1;
            this.narrate(KIND.REASONING_FINISHED, {
                symbol: event.symbol, route: ROUTE.CANDIDATE, correlationId,
                action: analysis?.action ?? null,
                executed: Boolean(analysis?.executed),
                holdingPositions: this.previousBySymbol.size > 0,
            });
            // The executing path journals its own decision, risk verdict and
            // outcome; recording it again here logged one decision twice. A
            // plain analyser port does not, so it is still recorded.
            if (!analysis?.journaled) {
                await record({ decision: analysis, risk: null, route: ROUTE.CANDIDATE,
                               executed: Boolean(analysis?.executed) });
            }
            return { route: ROUTE.CANDIDATE, action: analysis?.action ?? null,
                     executed: Boolean(analysis?.executed) };
        }

        if (route !== ROUTE.POSITION) return { skipped: "not a position event" };

        const position = (await this.ports.positionFor?.(event.symbol, asOf)) ?? null;
        if (!position) return { skipped: "position gone" };
        const thesis = (await this.ports.loadThesis?.(position)) ?? null;
        if (!thesis) return { skipped: "no thesis" };

        this.metrics.reasoningInvocations += 1;
        this.narrate(KIND.REASONING_STARTED, {
            symbol: event.symbol, route: ROUTE.POSITION, trigger: event.type,
            correlationId, severity: event.severity, because: event.reason,
            thesisId: thesis?.id ?? null,
        });
        const decision = await this.ports.reassess({
            position, thesis, event, asOf,
            marketState: this.lastContexts?.[event.symbol] ?? null,
            market: this.marketState,
        });
        this.metrics.lastDecisionAt = this.clock().toISOString();

        this.narrateReasoned({ event, correlationId, decision, route: ROUTE.POSITION });

        const built = this.ports.intentFrom(decision, position);
        // One thesis gets one exit, however many events argue for it.
        const intent = built ? {
            ...built,
            clientOrderId: positionIntentKey({
                thesisId: thesis?.id ?? null, action: built.action,
                symbol: event.symbol, at: asOf }),
        } : null;
        if (!intent) {
            await this.persistReassessment({ position, thesis, event, decision, risk: null,
                                             correlationId, executed: false });
            await record({ decision, risk: null, executed: false });
            this.narrateReassessment({ event, correlationId, decision, position, executed: false });
            this.narrate(KIND.REASONING_FINISHED, {
                symbol: event.symbol, route: ROUTE.POSITION, correlationId,
                action: decision.action, executed: false, holdingPositions: true,
            });
            return { action: decision.action, executed: false };
        }

        // Session policy is a hard gate, checked before risk: an exit is still
        // permitted in the closing window, a new entry is not.
        const reducing = ["EXIT", "REDUCE"].includes(decision.action);
        const capability = reducing ? "exits" : "newExposure";
        if (!permits(session, capability)) {
            await record({ decision, risk: null, executed: false,
                           blocked: `session ${session} does not permit ${capability}` });
            this.narrate(KIND.RISK_DECISION, {
                symbol: event.symbol, correlationId, decision: "REJECT",
                code: "SESSION", reason: `session ${session} does not permit ${capability}`,
            });
            this.narrate(KIND.REASONING_FINISHED, {
                symbol: event.symbol, route: ROUTE.POSITION, correlationId,
                action: decision.action, executed: false, holdingPositions: true });
            return { action: decision.action, executed: false, blocked: capability };
        }

        // Tier 4 on the position path. An exit is never blocked by drift, but
        // it is re-priced to the market and sized to what is actually held.
        const observation = {
            pricePaise: position.currentPricePaise,
            atMs: asOf.getTime() - (position.dataAgeMs ?? 0),
            tickSeq: null,
        };
        // Deliberately a FRESH read: the world may have moved while the model
        // was thinking, and that is the whole point of Tier 4.
        const world = (await this.ports.currentWorld?.(event.symbol)) ?? {
            nowMs: this.clock().getTime(),
            pricePaise: position.currentPricePaise,
            priceAgeMs: position.dataAgeMs ?? 0,
            position: { quantity: position.quantity },
        };
        const check = revalidate({ intent, observation, world });
        this.narrate(KIND.REVALIDATION, {
            symbol: event.symbol, correlationId, verdict: check.verdict,
            code: check.code ?? null, reason: check.reason ?? null,
            decisionPricePaise: observation.pricePaise,
            worldPricePaise: world.pricePaise ?? null,
            priceAgeMs: world.priceAgeMs ?? null,
        });
        if (check.verdict === VERDICT.REJECT) {
            await this.persistReassessment({ position, thesis, event, decision, risk: null,
                                             correlationId, executed: false });
            await record({ decision, risk: null, executed: false,
                           blocked: `revalidation ${check.code}: ${check.reason}` });
            this.narrateReassessment({ event, correlationId, decision, position, executed: false });
            this.narrate(KIND.REASONING_FINISHED, {
                symbol: event.symbol, route: ROUTE.POSITION, correlationId,
                action: decision.action, executed: false, holdingPositions: true });
            return { action: decision.action, executed: false, blocked: check.code };
        }
        const revalidated = check.intent;

        const risk = await this.ports.evaluateRisk({ ...revalidated, correlationId },
                                                   position, asOf);
        this.narrate(KIND.RISK_DECISION, {
            symbol: event.symbol, correlationId, decision: risk.decision,
            code: risk.code ?? null, reason: risk.reason ?? null,
            action: decision.action, quantity: revalidated.quantity,
        });
        if (risk.decision !== "ALLOW") {
            this.metrics.riskRejections += 1;
            await this.persistReassessment({ position, thesis, event, decision, risk,
                                             correlationId, executed: false });
            await record({ decision, risk, executed: false });
            this.narrateReassessment({ event, correlationId, decision, position, executed: false });
            this.narrate(KIND.REASONING_FINISHED, {
                symbol: event.symbol, route: ROUTE.POSITION, correlationId,
                action: decision.action, executed: false, holdingPositions: true });
            return { action: decision.action, executed: false, risk: risk.code };
        }

        const result = await this.ports.execute({ ...revalidated, correlationId });

        // The engine absorbs a repeat of an intent it has already seen and says
        // so. Recording that as an execution reported a trade that did not
        // happen: one thesis gets one action of each kind, and a second one
        // arriving is suppression, not success.
        const executed = !result?.duplicate;
        if (executed) {
            this.metrics.executions += 1;
            this.metrics.lastExecutionAt = this.clock().toISOString();
        } else {
            this.metrics.duplicatesSuppressed += 1;
        }

        await this.persistReassessment({ position, thesis, event, decision, risk,
                                         correlationId, executed });
        await record({ decision, risk, executed, intent: revalidated,
                       blocked: executed ? undefined
                           : `already actioned: ${revalidated.clientOrderId}` });
        this.narrateReassessment({ event, correlationId, decision, position, executed });
        this.narrate(KIND.REASONING_FINISHED, {
            symbol: event.symbol, route: ROUTE.POSITION, correlationId,
            action: decision.action, executed, holdingPositions: true,
            card: this.safeCard({ symbol: event.symbol, action: decision.action,
                                  decision, risk, intent: revalidated, order: result }),
        });
        return { action: decision.action, executed,
                 ...(executed ? {} : { blocked: "duplicate intent" }) };
    }

    // ---- narration -------------------------------------------------------
    //
    // Never on the decision path: a cockpit that could throw into reasoning
    // would be a display bug that stopped the system trading.
    narrate(kind, payload) {
        if (!this.narrator) return null;
        try { return this.narrator.emit(kind, payload); } catch (err) {
            this.logger?.warn?.("Orchestrator", "narration failed",
                                { error: err.message, kind });
            return null;
        }
    }

    narrateReasoned({ event, correlationId, decision, route }) {
        if (!this.narrator) return;
        // Guarded like every other narration call. A display failure must not
        // be able to abort a decision that has already been made.
        try {
            narrateDecision({ narrator: this.narrator, symbol: event.symbol,
                              trigger: event.type, route, correlationId, decision });
        } catch (err) {
            this.logger?.warn?.("Orchestrator", "decision narration failed",
                                { error: err.message });
        }
    }

    safeCard(input) {
        try { return decisionCard(input); } catch (err) {
            this.logger?.warn?.("Orchestrator", "decision card not built",
                                { error: err.message });
            return null;
        }
    }

    narrateReassessment({ event, correlationId, decision, position, executed }) {
        this.narrate(KIND.REASSESSMENT, {
            symbol: event.symbol, correlationId, trigger: event.type,
            action: decision.action,
            thesisStillValid: decision.thesisStillValid ?? null,
            whatChanged: decision.whatChanged ?? null,
            material: Boolean(decision.material),
            unrealisedPnlPaise: position?.unrealisedPnlPaise ?? null,
            holdingSeconds: position?.holdingSeconds ?? null,
            executed,
        });
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
