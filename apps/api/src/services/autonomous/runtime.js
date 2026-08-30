import { randomUUID } from "node:crypto";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { PaperVenue } from "../execution/paperVenue.js";
import { scanUniverse, DEFAULT_SCREEN } from "./candidates.js";
import { evaluate as evaluateRisk, DECISION } from "./riskGate.js";
import { intentFrom } from "./loop.js";
import { permits } from "../orchestrator/session.js";
import { revalidate, VERDICT } from "../execution/revalidate.js";
import { SymbolGate, entryIntentKey } from "./symbolGate.js";
import { ReflexLane, CROSSING, DIRECTION } from "../tick/reflex.js";
import { makeEvent, EVENT_TYPES, SEVERITY } from "./events.js";

// The autonomous runtime.
//
// Assembles the pieces built across Phases 1-5 into something that can run a
// session unattended: intelligence -> events -> reasoning -> risk -> paper
// execution -> reconciliation -> monitoring -> reasoning again.
//
// It owns no domain logic of its own. Every rule lives in the component that
// owns it, and this wires them together with one execution port.
//
// PAPER ONLY. `executionPort` defaults to the PaperVenue. A real broker
// adapter would replace that one object without touching reasoning, risk, the
// orchestrator, position state or the event system.

export const MODE = { PAPER: "PAPER", LIVE: "LIVE" };

export class AutonomousRuntime {
    constructor({
        engine, reconciler, ports, mode = MODE.PAPER,
        venueScript = {}, screen = DEFAULT_SCREEN, barAggregator = null,
        clock = () => new Date(), logger = null, userId = 1,
    }) {
        if (mode !== MODE.PAPER) {
            // The guard is here rather than in configuration so enabling live
            // trading cannot be an accident of environment.
            throw new Error("live mode is not implemented; Phase 6 is paper only");
        }
        this.mode = mode;
        this.engine = engine;
        this.reconciler = reconciler;
        this.userId = userId;
        this.clock = clock;
        this.logger = logger;
        this.screen = screen;
        this.sourcePorts = ports;
        this.barAggregator = barAggregator;

        this.venue = new PaperVenue({ engine, script: venueScript, clock, logger });
        // One symbol, one decision in flight. Both entry paths and the
        // reassessment path pass through this.
        this.gate = new SymbolGate({ clock: () => this.clock().getTime(), logger });

        // Tier 0. Levels recorded at entry are tested on every tick, and a
        // crossing acts immediately. Reasoning runs afterwards to decide what
        // the crossing meant, not whether to protect.
        this.reflex = new ReflexLane({
            clock: () => this.clock().getTime(), logger,
            onCrossing: (crossing) => this.protect(crossing),
        });

        this.metrics = {
            candidatesScanned: 0, candidatesPassed: 0, candidatesSuppressed: 0,
            candidateReasoning: 0, entriesOpened: 0, candidatesGated: 0,
            venueTicks: 0, reconciliations: 0, revalidationRejections: 0,
            protectiveActions: 0, protectiveExits: 0, barsClosed: 0,
        };

        this.orchestrator = new Orchestrator({
            clock, logger,
            ports: this.buildOrchestratorPorts(),
        });

        this.registerRuntimeJobs();
    }

    buildOrchestratorPorts() {
        const p = this.sourcePorts;
        return {
            ...p,
            // The single execution port. Everything approved passes through
            // here and nowhere else.
            execute: async (intent) => this.executeIntent(intent),
            analyseCandidate: p.analyseCandidate
                ? async (input) => this.handleCandidate(input) : undefined,
            openOrders: () => this.engine.openOrders(this.userId),
            reconcileAll: () => this.reconcile(),
            expireStaleOrders: (now) => this.engine.expireStaleOrders(now),
        };
    }

    registerRuntimeJobs() {
        const scheduler = this.orchestrator.scheduler;

        scheduler.register({
            name: "candidate-scan",
            intervalMs: 60_000,
            shouldRun: () => permits(this.orchestrator.session(), "discovery"),
            run: () => this.candidateScan(),
        });

        // Tier 1 cadence. Bars close because the minute ended, not because a
        // tick happened to arrive.
        if (this.barAggregator) {
            scheduler.register({
                name: "bar-close",
                intervalMs: 5_000,
                shouldRun: () => permits(this.orchestrator.session(), "marketData"),
                run: async () => {
                    const closed = await this.barAggregator.closeCompleted(this.clock().getTime());
                    this.metrics.barsClosed += closed.length;
                    return closed.length;
                },
            });
        }

        scheduler.register({
            name: "venue-tick",
            intervalMs: 5_000,
            shouldRun: () => true,   // resting orders must progress in any session
            run: async () => {
                const advanced = await this.venue.tick();
                this.metrics.venueTicks += 1;
                return advanced.length;
            },
        });

        scheduler.register({
            name: "news-ingest",
            intervalMs: 60_000,
            shouldRun: () => Boolean(this.sourcePorts.ingestNews),
            run: () => this.sourcePorts.ingestNews(this.clock()),
        });

        scheduler.register({
            name: "health",
            intervalMs: 30_000,
            shouldRun: () => true,
            run: async () => this.health(),
        });
    }

    // ---- execution -------------------------------------------------------

    async executeIntent(intent) {
        const enriched = {
            ...intent,
            userId: this.userId,
            // Idempotency boundary: one logical action per decision, per
            // symbol, per action. A repeat produces the same id and the engine
            // absorbs it.
            clientOrderId: intent.clientOrderId
                ?? `${intent.correlationId}:${intent.action}:${intent.symbol}`,
        };
        return this.venue.submit(enriched);
    }

    // ---- reflex ----------------------------------------------------------

    // Every tick, from the websocket. Synchronous and allocation-light: this
    // runs hundreds of times a second across the universe.
    ingestTick({ symbol, price, timestamp }) {
        if (!symbol || !Number.isFinite(price)) return [];
        return this.reflex.onTick({
            symbol, pricePaise: Math.round(price * 100),
            at: timestamp ?? this.clock().getTime(),
        });
    }

    // Load the pre-commitments of everything currently held. Called on start
    // and after every entry, so a restart does not leave a position unprotected.
    async armOpenPositions() {
        const positions = (await this.sourcePorts.loadPositions?.()) ?? [];
        let armed = 0;
        for (const position of positions) {
            if (!position.thesisId) continue;
            const ok = this.reflex.arm(position.symbol, {
                thesisId: position.thesisId,
                direction: position.side === "SELL" ? DIRECTION.SHORT : DIRECTION.LONG,
                stopPaise: position.stopPaise ?? null,
                targetPaise: position.targetPaise ?? null,
                quantity: position.quantity,
                correlationId: position.correlationId,
            });
            if (ok) armed += 1;
        }
        return { armed, positions: positions.length };
    }

    // The pre-committed action. No model, no queue, no poll: the decision was
    // made when the thesis was written and the risk gate approved the position
    // those levels belong to. The engine remains the authority on whether the
    // sell is possible at all.
    async protect(crossing) {
        const { symbol, kind, quantity, thesisId, correlationId, pricePaise } = crossing;
        this.metrics.protectiveActions += 1;

        // A target reach is not automatically an exit: the thesis may deserve
        // to run. It raises an event and lets the trader decide, immediately.
        if (kind === CROSSING.TARGET) {
            await this.raiseCrossingEvent(crossing, SEVERITY.WARNING, EVENT_TYPES.TARGET_BREACH);
            return { protected: false, reason: "target reached; handed to reasoning" };
        }

        const position = (await this.sourcePorts.positionFor?.(symbol)) ?? null;
        const held = position?.quantity ?? 0;
        if (held <= 0) {
            this.reflex.disarm(symbol);
            return { protected: false, reason: "position already closed" };
        }

        const size = Math.min(quantity || held, held);
        const intent = {
            action: "EXIT", side: "SELL", symbol, quantity: size,
            pricePaise, referencePricePaise: pricePaise,
            correlationId: correlationId ?? `reflex-${symbol}`,
            thesisId,
            // One protective exit per thesis per crossing kind, whatever else
            // is happening elsewhere in the system.
            clientOrderId: `${thesisId ?? symbol}:PROTECT:${kind}`,
        };

        try {
            await this.executeIntent(intent);
            this.metrics.protectiveExits += 1;
            this.reflex.disarm(symbol);
            this.logger?.warn?.("Reflex", "protective exit submitted", {
                symbol, kind, quantity: size, pricePaise });
        } catch (err) {
            this.logger?.error?.("Reflex", "protective exit failed",
                                 { error: err.message, symbol, kind });
            return { protected: false, error: err.message };
        }

        // Now tell the trader what happened, so the thesis is reassessed with
        // the exit already in the record.
        await this.raiseCrossingEvent(crossing, SEVERITY.CRITICAL, EVENT_TYPES.STOP_BREACH);
        return { protected: true, quantity: size };
    }

    async raiseCrossingEvent(crossing, severity, type) {
        try {
            const event = makeEvent({
                type, severity, symbol: crossing.symbol,
                thesisId: crossing.thesisId,
                correlationId: crossing.correlationId ?? `reflex-${crossing.symbol}`,
                source: "reflex_lane",
                observed: { kind: crossing.kind, pricePaise: crossing.pricePaise,
                            levelPaise: crossing.levelPaise, detector: "reflex_v1" },
                reason: `${crossing.kind} crossed at ${crossing.pricePaise} against ${crossing.levelPaise}`,
                observedAt: new Date(crossing.at),
                bucket: crossing.kind.toLowerCase(),
            });
            const stored = await this.sourcePorts.recordEvent?.(event);
            if (stored) {
                this.orchestrator.queue.offer(
                    { ...event, storedId: stored.id, severity: stored.severity ?? severity },
                    this.clock().getTime());
            }
        } catch (err) {
            this.logger?.error?.("Reflex", "could not raise the crossing event",
                                 { error: err.message, symbol: crossing.symbol });
        }
    }

    // ---- candidates ------------------------------------------------------

    async candidateScan() {
        const now = this.clock();
        if (!this.sourcePorts.loadObservations) return { candidates: 0 };

        const observations = await this.sourcePorts.loadObservations();
        const positions = (await this.sourcePorts.loadPositions?.()) ?? [];
        const held = new Set(positions.map((p) => p.symbol));

        const result = scanUniverse({
            observations, heldSymbols: held, asOf: now,
            screen: this.screen, calculatedAt: now,
        });

        this.metrics.candidatesScanned += result.examined.length;
        this.metrics.candidatesPassed += result.candidates.length;
        this.metrics.candidatesSuppressed += result.suppressed;

        for (const candidate of result.candidates) {
            await this.handleCandidate({ symbol: candidate.symbol, context: candidate.context,
                                         reasons: candidate.reasons });
        }
        return { candidates: result.candidates.length, examined: result.examined.length };
    }

    // A candidate is a different question from a position: "is there enough
    // evidence to establish one" rather than "is the thesis still valid".
    async handleCandidate({ symbol, context = null, event = null, reasons = [] }) {
        if (!this.sourcePorts.analyseCandidate) return { skipped: "no analyser" };
        const session = this.orchestrator.session();
        if (!permits(session, "discovery")) return { skipped: `session ${session}` };

        // The scan job and the reasoning job can both arrive here for the same
        // symbol within seconds of each other.
        const release = this.gate.acquire(symbol, "candidate");
        if (!release) {
            this.metrics.candidatesGated += 1;
            return { skipped: "symbol already being reasoned about" };
        }
        try {
            return await this.decideCandidate({ symbol, context, event, reasons, session });
        } finally {
            release();
        }
    }

    async decideCandidate({ symbol, context, event, reasons }) {
        const correlationId = `cand-${randomUUID()}`;
        this.metrics.candidateReasoning += 1;

        const decision = await this.sourcePorts.analyseCandidate({
            symbol, context, event, reasons, correlationId,
            market: this.orchestrator.marketState,
        });

        if (!decision || decision.action !== "BUY") {
            await this.sourcePorts.journal?.({
                correlationId, symbol, decision, risk: null, executed: false, route: "CANDIDATE" });
            return { action: decision?.action ?? null, executed: false, journaled: true };
        }

        const price = context?.price ?? null;
        if (!Number.isFinite(price)) {
            await this.sourcePorts.journal?.({
                correlationId, symbol, decision, risk: null, executed: false,
                blocked: "no usable price for sizing" });
            return { action: "BUY", executed: false, blocked: "no price", journaled: true };
        }

        // Identity is the intent, not the decision. Two concurrent decisions to
        // buy the same symbol in the same position state now collide at the
        // engine instead of producing two orders.
        const epoch = (await this.sourcePorts.entryEpoch?.(symbol)) ?? 0;
        const proposed = {
            action: "BUY", side: "BUY", symbol,
            quantity: decision.quantity ?? 1,
            pricePaise: Math.round(price * 100),
            referencePricePaise: Math.round(price * 100),
            correlationId,
            clientOrderId: entryIntentKey({ symbol, action: "BUY", at: this.clock(), epoch }),
        };

        // Tier 4. The decision was formed from `context`; the world may have
        // moved while the model was thinking. Executing against the snapshot is
        // the failure this prevents.
        const observation = {
            pricePaise: Math.round(price * 100),
            atMs: context?.asOf ? new Date(context.asOf).getTime() : this.clock().getTime(),
            tickSeq: context?.tickSeq ?? null,
        };
        const world = (await this.sourcePorts.currentWorld?.(symbol)) ?? {
            nowMs: this.clock().getTime(),
            pricePaise: observation.pricePaise,
            priceAgeMs: 0,
            position: null,
        };
        const check = revalidate({ intent: proposed, observation, world });
        if (check.verdict === VERDICT.REJECT) {
            this.metrics.revalidationRejections += 1;
            await this.sourcePorts.journal?.({
                correlationId, symbol, decision, risk: null, executed: false,
                blocked: `revalidation ${check.code}: ${check.reason}` });
            return { action: "BUY", executed: false, blocked: check.code, journaled: true };
        }
        const intent = check.intent;

        const portfolio = await this.sourcePorts.loadPortfolio();
        const risk = evaluateRisk(intent, {
            portfolio, nowMs: world.nowMs ?? this.clock().getTime(),
            stale: Boolean(context?.stale),
            session: (await this.sourcePorts.sessionCounters?.()) ?? {},
            openClientOrderIds: (await this.sourcePorts.openClientOrderIds?.()) ?? [],
        });

        if (risk.decision !== DECISION.ALLOW) {
            await this.sourcePorts.journal?.({
                correlationId, symbol, decision, risk, executed: false });
            return { action: "BUY", executed: false, risk: risk.code, journaled: true };
        }

        // Entry persists the immutable thesis BEFORE the order, so a fill can
        // never exist without the reasoning that justified it.
        const thesis = await this.sourcePorts.recordThesis?.({
            symbol, correlationId, decision, context, intent });

        await this.executeIntent({ ...intent, thesisId: thesis?.id ?? null });
        this.metrics.entriesOpened += 1;

        // Protect it from the very next tick, not from the next poll.
        if (thesis?.id) {
            this.reflex.arm(symbol, {
                thesisId: thesis.id, direction: DIRECTION.LONG,
                stopPaise: thesis.stop_paise === null || thesis.stop_paise === undefined
                    ? null : Number(thesis.stop_paise),
                targetPaise: thesis.target_paise === null || thesis.target_paise === undefined
                    ? null : Number(thesis.target_paise),
                quantity: intent.quantity, correlationId,
            });
        }

        await this.sourcePorts.journal?.({
            correlationId, symbol, decision, risk, executed: true, thesisId: thesis?.id ?? null });
        return { action: "BUY", executed: true, thesisId: thesis?.id ?? null, journaled: true };
    }

    // ---- reconciliation --------------------------------------------------

    async reconcile() {
        if (!this.reconciler) return [];
        this.metrics.reconciliations += 1;
        return this.reconciler.reconcileAll(this.userId, (order) => this.venue.externalStateOf(order));
    }

    // ---- lifecycle -------------------------------------------------------

    async start() {
        const started = await this.orchestrator.start();
        await this.armOpenPositions();
        return started;
    }
    async stop() { return this.orchestrator.stop(); }

    health() {
        return {
            mode: this.mode,
            liveExecutionEnabled: false,
            orchestrator: this.orchestrator.health(),
            venue: this.venue.health(),
            reflex: this.reflex.health(),
            gate: this.gate.health(),
            runtime: { ...this.metrics },
        };
    }
}
