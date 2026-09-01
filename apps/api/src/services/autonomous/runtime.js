import { randomUUID } from "node:crypto";
import { Orchestrator } from "../orchestrator/orchestrator.js";
import { PaperVenue } from "../execution/paperVenue.js";
import { scanUniverse, DEFAULT_SCREEN, clearsCostHurdle } from "./candidates.js";
import { evaluate as evaluateRisk, DECISION } from "./riskGate.js";
import { intentFrom } from "./loop.js";
import { permits } from "../orchestrator/session.js";
import { revalidate, VERDICT } from "../execution/revalidate.js";
import { SymbolGate, entryIntentKey } from "./symbolGate.js";
import { ReflexLane, CROSSING, DIRECTION, isProtective,
         DEFAULT_STALE_AFTER_MS } from "../tick/reflex.js";
import { makeEvent, EVENT_TYPES, SEVERITY } from "./events.js";
import { THRESHOLDS } from "../intelligence/anomaly.js";
import { FastPlaneBridge, PLANE_MODE } from "../tick/fastPlane.js";
import { KIND } from "../cockpit/narrator.js";
import { modelBudget, tokenBudget } from "../aiEngine.js";

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

// How many unreconciled crossings the brain will hold for shadow comparison.
const MAX_COMPARISON_BUFFER = 2_000;

// How many candidates one discovery pass will reason about. The scan runs every
// minute; anything beyond this waits for the next one rather than blocking the
// scheduler behind a rate-limited model.
// Raised from 2 for paper trading. The provider ceiling is 8,000 tokens a
// minute and a decision costs about 4,000, so this is not what limits
// throughput — it decides how much of a scan's shortlist gets looked at
// before the next scan replaces it.
const MAX_SCAN_REASONING = 3;

// How long before the same symbol is worth reasoning about again.
//
// Measured live: OLAELEC was reasoned about four times and KPRMILL three times
// inside ten minutes, each a fresh pair of model calls costing roughly 3,270
// tokens. Nothing material had changed between them — the scanner simply kept
// surfacing the same name, and every pass paid full price to reach the same
// conclusion. A quota that buys sixty decisions a day cannot afford to spend
// four of them on one symbol in ten minutes.
//
// This throttles DISCOVERY only. A position already carrying capital is never
// throttled: a material event on something we own is exactly the question worth
// paying for.
// Shortened from fifteen minutes to five for paper trading. Fifteen was set
// when the same names were being re-reasoned within minutes at full price; the
// cost hurdle now turns most of those away before a model call, so the cooldown
// no longer has to carry that job alone.
const CANDIDATE_COOLDOWN_MS = Number(process.env.ZENTRADE_CANDIDATE_COOLDOWN_MS) || 5 * 60_000;

// The trading session, in IST minutes since midnight, used to pace the
// reasoning budget across it.
const SESSION_OPEN_MINUTE = 9 * 60 + 15;
const SESSION_CLOSE_MINUTE = 15 * 60 + 30;
const SESSION_MINUTES = SESSION_CLOSE_MINUTE - SESSION_OPEN_MINUTE;

// How far through the trading session we are, 0 to 1.
export const sessionProgress = (now) => {
    const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (minute <= SESSION_OPEN_MINUTE) return 0;
    if (minute >= SESSION_CLOSE_MINUTE) return 1;
    return (minute - SESSION_OPEN_MINUTE) / SESSION_MINUTES;
};

// Is discovery spending faster than the session can afford?
//
// Measured live: 9 decisions in 3.3 minutes at 2,565 tokens each is about
// 6,900 tokens a minute, which spends a 200,000 allowance in 29 minutes of a
// 375-minute session. A per-symbol cooldown alone does not fix that — the
// scanner simply moves to the next symbol.
//
// So discovery is paced against the clock: at any moment it may have spent at
// most the fraction of the budget matching the fraction of the session
// elapsed, plus a small head start so the open is not starved. Being ahead of
// pace pauses discovery until the session catches up. Position reassessment is
// never paced — capital already at risk is not a budgeting question.
// Raised from 0.15 for paper trading. At 0.15 the first forty minutes of the
// session — the open, where the day's clearest setups are — allowed only about
// a fifth of the budget, and `candidatesPaced` reached 44 in a single process
// while the account took no trades at all.
const PACE_HEAD_START = 0.40;

export const discoveryAheadOfPace = (tokens, now) => {
    if (!tokens || tokens.budget <= 0) return false;
    const allowedFraction = Math.min(1, sessionProgress(now) + PACE_HEAD_START);
    return (tokens.used / tokens.budget) > allowedFraction;
};

// The contract's kind vocabulary maps onto the reflex's one-to-one, so a plane
// event and a local crossing reach the same protect() and cannot diverge in
// how they are handled.
const CROSSING_FROM_KIND = {
    STOP: CROSSING.STOP,
    TARGET: CROSSING.TARGET,
    INVALIDATION: CROSSING.INVALIDATION,
    STOP_APPROACH: CROSSING.STOP_APPROACH,
    TARGET_APPROACH: CROSSING.TARGET_APPROACH,
    PRICE_JUMP: CROSSING.PRICE_JUMP,
    VWAP_DEVIATION: CROSSING.VWAP_DEVIATION,
    VOLUME_SPIKE: CROSSING.VOLUME_SPIKE,
};

// How a continuously detected material change becomes an attention event.
// These used to be found by the 15-second sweep; they are now found on the
// tick that causes them, and routed to exactly the same event vocabulary.
const SIGNAL_ROUTING = {
    [CROSSING.TARGET]: { type: EVENT_TYPES.TARGET_BREACH, severity: SEVERITY.WARNING },
    [CROSSING.STOP_APPROACH]: { type: EVENT_TYPES.STOP_APPROACHING, severity: SEVERITY.WARNING },
    [CROSSING.TARGET_APPROACH]: { type: EVENT_TYPES.TARGET_APPROACHING, severity: SEVERITY.INFO },
    [CROSSING.PRICE_JUMP]: { type: EVENT_TYPES.PRICE_JUMP, severity: SEVERITY.WARNING },
    // Direction decides the label. A price EXTENDED above VWAP is not a
    // breakdown, and calling it one taught the operator to distrust the word.
    [CROSSING.VWAP_DEVIATION]: (crossing) => (
        crossing.pricePaise < crossing.levelPaise
            ? { type: EVENT_TYPES.TECHNICAL_BREAKDOWN, severity: SEVERITY.WARNING }
            : { type: EVENT_TYPES.PRICE_JUMP, severity: SEVERITY.WARNING }),
    [CROSSING.VOLUME_SPIKE]: { type: EVENT_TYPES.VOLUME_SPIKE, severity: SEVERITY.WARNING },
};

export class AutonomousRuntime {
    constructor({
        engine, reconciler, ports, mode = MODE.PAPER,
        venueScript = {}, screen = DEFAULT_SCREEN, barAggregator = null,
        clock = () => new Date(), logger = null, userId = 1,
        staleSweepMs = 1_000, staleAfterMs = DEFAULT_STALE_AFTER_MS,
        fastPlane = null, narrator = null,
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
        this.staleSweepMs = staleSweepMs;
        this.staleAfterMs = staleAfterMs;
        this.lastStaleSweepAt = null;

        // The Go fast plane. OFF by default: the Node reflex is authoritative
        // until a shadow session has run with zero divergence. In SHADOW the
        // plane sees the same commands and the same ticks, and its events are
        // compared rather than acted on.
        this.fastPlane = fastPlane ?? new FastPlaneBridge({ mode: PLANE_MODE.OFF, logger });
        // Crossings the Node reflex produced since the last reconciliation.
        this.recentCrossings = [];
        // Events the plane pushed while running in shadow.
        this.planeShadowEvents = [];

        this.venue = new PaperVenue({ engine, script: venueScript, clock, logger });
        // One symbol, one decision in flight. Both entry paths and the
        // reassessment path pass through this.
        this.gate = new SymbolGate({ clock: () => this.clock().getTime(), logger });
        // When each symbol was last reasoned about as a CANDIDATE, so the same
        // name is not re-priced every scan while nothing has changed.
        this.lastCandidateReasoningAt = new Map();
        // Open positions no level is protecting, refreshed every time the
        // commitments are rebuilt. Empty until the first pass has run.
        this.unprotected = [];
        // What was reported last time, so a standing condition is stated once
        // rather than on every pass of the audit.
        this.unprotectedSignature = "";

        // Tier 0. Levels recorded at entry are tested on every tick, and a
        // crossing acts immediately. Reasoning runs afterwards to decide what
        // the crossing meant, not whether to protect.
        this.reflex = new ReflexLane({
            clock: () => this.clock().getTime(), logger,
            onCrossing: (crossing) => {
                if (this.fastPlane.enabled) this.recordForComparison(crossing);
                // ONE authoritative detector. When the Go plane is live it owns
                // detection, and the local lane keeps state for comparison and
                // for the supervisory range without acting on it. Two actors
                // reacting to one crossing is two exits.
                if (this.fastPlane.authoritative) {
                    this.metrics.localCrossingsSuppressed += 1;
                    return null;
                }
                return this.protect(crossing);
            },
        });

        this.metrics = {
            candidatesScanned: 0, candidatesPassed: 0, candidatesSuppressed: 0,
            candidateReasoning: 0, entriesOpened: 0, candidatesGated: 0,
            venueTicks: 0, reconciliations: 0, revalidationRejections: 0,
            protectiveActions: 0, protectiveExits: 0, barsClosed: 0, materialSignals: 0,
            staleSweeps: 0, blindSymbols: 0,
            planeEvents: 0, planeRejected: 0, localCrossingsSuppressed: 0,
            candidatesDeferred: 0, candidatesCooledDown: 0, candidatesBudgetSkipped: 0,
            candidatesPaced: 0, protectiveRetries: 0, ordersAdopted: 0, haltChanges: 0,
            planeAuthorityChanges: 0, unprotectedPositions: 0,
            candidatesBelowCostHurdle: 0,
        };

        // Optional throughout: the runtime behaves identically without one,
        // and narration can never change or delay a decision.
        this.narrator = narrator;

        this.orchestrator = new Orchestrator({
            clock, logger, narrator,
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
            syncBaselines: (contexts) => this.syncBaselines(contexts),
            analyseCandidate: p.analyseCandidate
                ? async (input) => this.handleCandidate(input) : undefined,
            openOrders: () => this.engine.openOrders(this.userId),
            reconcileAll: () => this.reconcile(),
            // Scoped to this account. Unscoped, one runtime would expire another
            // account's resting orders, which is not its business.
            expireStaleOrders: (now) => this.engine.expireStaleOrders(now, this.userId),
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

        // The one condition that legitimately stays timer driven: absence of
        // ticks cannot arrive as a tick. It runs a hundred times more often
        // than the supervisory monitor because a blind reflex lane is a
        // protection failure, not a data-quality note.
        scheduler.register({
            name: "stale-sweep",
            intervalMs: this.staleSweepMs,
            // Silence only means something while an exit is possible. Outside
            // that window there is nothing to protect and nothing to fix.
            shouldRun: () => permits(this.orchestrator.session(), "exits"),
            run: () => this.staleSweep(),
        });

        // Protection drifts. A position can lose its cover mid-session — a
        // thesis closed while the holding remains, an entry whose arming failed
        // — and the answer at start is not the answer an hour later. Picks up
        // anything uncovered and leaves everything already armed alone.
        scheduler.register({
            name: "protection-audit",
            intervalMs: 30_000,
            shouldRun: () => permits(this.orchestrator.session(), "positionMonitor"),
            run: () => this.armOpenPositions(),
        });

        scheduler.register({
            name: "venue-tick",
            intervalMs: 5_000,
            shouldRun: () => true,   // resting orders must progress in any session
            run: async () => {
                const advanced = await this.venue.tick();
                this.metrics.venueTicks += 1;
                // A resting order moving through the state machine is part of
                // the lifecycle an operator is watching.
                for (const order of advanced) this.narrateOrder(order, null);
                return advanced.length;
            },
        });

        scheduler.register({
            name: "news-ingest",
            intervalMs: 60_000,
            shouldRun: () => Boolean(this.sourcePorts.ingestNews),
            run: () => this.sourcePorts.ingestNews(this.clock()),
        });

        // Shadow reconciliation. Only registered when the plane is running, so
        // the default configuration adds no job and no work.
        if (this.fastPlane.enabled) {
            scheduler.register({
                name: "fast-plane-reconcile",
                intervalMs: 5_000,
                shouldRun: () => true,
                run: () => this.reconcileFastPlane(),
            });
            // Who is protecting the position. A plane configured LIVE that has
            // died must hand detection back to the local lane rather than leave
            // nobody watching, and that can only be noticed by asking.
            scheduler.register({
                name: "plane-authority",
                intervalMs: 2_000,
                shouldRun: () => true,
                run: () => this.checkPlaneAuthority(),
            });
        }

        // The operator's stop, read from the shared key.
        //
        // The only orchestrator lives in this process, so the API cannot halt
        // it directly. It writes the intent and this applies it. Runs in every
        // session state, because being unable to stop a trader outside market
        // hours is not a property worth having.
        if (this.sourcePorts.readHaltRequest) {
            scheduler.register({
                name: "halt-watch",
                intervalMs: 2_000,
                shouldRun: () => true,
                run: () => this.applyHaltRequest(),
            });
        }

        scheduler.register({
            name: "health",
            intervalMs: 30_000,
            shouldRun: () => true,
            run: async () => this.health(),
        });
    }

    // ---- operator control ------------------------------------------------

    async applyHaltRequest() {
        const request = await this.sourcePorts.readHaltRequest();
        // Null means the request could not be read. Treating that as "not
        // halted" would silently resume a trader the operator stopped, so the
        // last known state stands.
        if (!request) return { halted: this.orchestrator.halted, changed: false,
                               unreadable: true };
        const halted = Boolean(request.halted);
        if (halted === this.orchestrator.halted) return { halted, changed: false };

        this.orchestrator.setHalted(halted, request.reason ?? "operator request");
        this.metrics.haltChanges += 1;
        this.logger?.warn?.("Runtime", halted ? "halted by the operator" : "resumed by the operator",
                            { reason: request.reason ?? null });
        this.narrate(KIND.HALT, {
            state: halted ? "HALTED" : "RESUMED",
            because: request.reason ?? "operator request",
            session: this.orchestrator.session(),
        });
        return { halted, changed: true };
    }

    // ---- narration -------------------------------------------------------

    narrate(kind, payload) {
        if (!this.narrator) return null;
        try { return this.narrator.emit(kind, payload); } catch (err) {
            this.logger?.warn?.("Runtime", "narration failed",
                                { error: err.message, kind });
            return null;
        }
    }

    // The real Phase 1 state machine's states, never invented ones.
    narrateOrder(result, intent) {
        const order = result?.order ?? result;
        if (!order?.state) return;
        this.narrate(KIND.ORDER_STATE_CHANGED, {
            symbol: order.symbol ?? intent?.symbol ?? null,
            orderId: order.id ?? null,
            state: order.state,
            side: order.type ?? intent?.side ?? null,
            quantity: Number(order.quantity ?? intent?.quantity ?? 0),
            filledQuantity: Number(order.filled_quantity ?? 0),
            pricePaise: Number(order.price_paise ?? intent?.pricePaise ?? 0),
            clientOrderId: order.client_order_id ?? intent?.clientOrderId ?? null,
            correlationId: order.correlation_id ?? intent?.correlationId ?? null,
            duplicate: Boolean(result?.duplicate),
        });
        if (order.state === "FILLED" || order.state === "PARTIALLY_FILLED") {
            this.narrate(KIND.FILL, {
                symbol: order.symbol ?? intent?.symbol ?? null,
                orderId: order.id ?? null,
                state: order.state,
                filledQuantity: Number(order.filled_quantity ?? 0),
                quantity: Number(order.quantity ?? 0),
                pricePaise: Number(order.price_paise ?? 0),
                pnlPaise: order.pnl_paise === null || order.pnl_paise === undefined
                    ? null : Number(order.pnl_paise),
            });
        }
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
        const result = await this.venue.submit(enriched);
        this.narrateOrder(result, enriched);
        return result;
    }

    // ---- reflex ----------------------------------------------------------

    // VWAP and typical volume are bar-scale quantities computed by the
    // intelligence pass. The tick path cannot derive either, so the bar path
    // pushes them in and the tick path compares against them. Called once per
    // observation cycle.
    syncBaselines(contexts) {
        if (!contexts) return { vwap: 0, volume: 0 };
        let vwap = 0;
        let volume = 0;
        for (const [symbol, context] of Object.entries(contexts)) {
            if (!this.reflex.isWatched(symbol)) continue;
            if (context?.vwapAvailable && Number.isFinite(context.vwap)
                && this.reflex.updateVwap(symbol, Math.round(context.vwap * 100))) vwap += 1;
            if (Number.isFinite(context?.volumeBaseline)
                && this.reflex.updateVolumeBaseline(symbol, {
                    baseline: context.volumeBaseline,
                    // The intelligence layer owns what counts as a spike.
                    ratio: THRESHOLDS.volumeRatioWarning,
                })) {
                volume += 1;
                this.fastPlane.volumeBaseline(symbol, context.volumeBaseline,
                                              THRESHOLDS.volumeRatioWarning);
            }
        }
        return { vwap, volume };
    }


    // ---- fast plane ------------------------------------------------------

    // One event from the Go plane, arriving by push.
    //
    // It is translated into the reflex's own crossing shape and handed to the
    // SAME protect() a local crossing reaches, so a stop breach is handled
    // identically whichever plane saw it.
    onPlaneEvent(event) {
        const kind = CROSSING_FROM_KIND[event?.kind];
        if (!kind || !event.symbol) {
            this.metrics.planeRejected += 1;
            return null;
        }
        this.metrics.planeEvents += 1;
        this.narrate(KIND.MARKET_EVENT, {
            symbol: event.symbol, type: event.kind, severity: event.severity,
            reason: event.reason ?? `${event.kind} on the tick`,
            // The cockpit distinguishes a fast-plane observation from reasoning,
            // risk and execution while showing them on one timeline.
            source: "FAST_PLANE", detector: "go_marketdata_v1",
            pricePaise: event.pricePaise ?? null,
            levelPaise: event.levelPaise ?? null,
            thesisId: event.thesisId || null,
        });

        // In shadow the plane observes and nothing acts on it.
        if (!this.fastPlane.authoritative) {
            this.planeShadowEvents.push(event);
            if (this.planeShadowEvents.length > MAX_COMPARISON_BUFFER) {
                this.planeShadowEvents.splice(
                    0, this.planeShadowEvents.length - MAX_COMPARISON_BUFFER);
            }
            return null;
        }

        return this.protect({
            kind, symbol: event.symbol,
            pricePaise: event.pricePaise ?? null,
            levelPaise: event.levelPaise ?? null,
            thesisId: event.thesisId || null,
            correlationId: event.correlationId || `plane-${event.symbol}`,
            quantity: 0,      // sized from the holding at protect() time
            at: event.observedTs ?? this.clock().getTime(),
            reason: event.reason ?? null,
        });
    }

    // Who owns detection right now, and what changes when that moves.
    //
    // A level that broke while the plane was authoritative latched the local
    // lane and was deliberately not acted on. If authority comes back here,
    // that latch would stop the local lane ever firing a level it has already
    // seen, so every armed level is re-opened and judged again on the next
    // tick. Re-arming is safe: the protective exit's client order id is the
    // same from either path, so the engine absorbs a repeat.
    async checkPlaneAuthority() {
        const before = this.fastPlane.authoritative;
        await this.fastPlane.checkAlive();
        const after = this.fastPlane.authoritative;
        if (before === after) return { authoritative: after, changed: false };

        this.metrics.planeAuthorityChanges += 1;
        if (!after) {
            const reopened = this.reflex.rearmAll();
            this.logger?.error?.("FastPlane",
                "the plane stopped answering; protection is back on the local lane",
                { reopenedLevels: reopened });
            this.narrate(KIND.PROTECTION, {
                state: "HANDOVER", protectedBy: "node_reflex", reopenedLevels: reopened,
                because: "the fast plane stopped answering; the local reflex is protecting again",
            });
        } else {
            this.logger?.info?.("FastPlane", "the plane is answering and now owns detection");
            this.narrate(KIND.PROTECTION, {
                state: "HANDOVER", protectedBy: "go_fast_plane", reopenedLevels: 0,
                because: "the fast plane is answering and now owns detection",
            });
        }
        return { authoritative: after, changed: true };
    }

    // Bounded. A brain that stopped reconciling must not accumulate crossings
    // until it runs out of memory; the oldest are dropped and the loss shows up
    // as divergence rather than as a leak.
    recordForComparison(crossing) {
        this.recentCrossings.push(crossing);
        if (this.recentCrossings.length > MAX_COMPARISON_BUFFER) {
            this.recentCrossings.splice(0, this.recentCrossings.length - MAX_COMPARISON_BUFFER);
        }
    }

    // Compare what the two implementations saw. In SHADOW this is the only
    // thing the plane's output is used for; nothing downstream reads it.
    async reconcileFastPlane() {
        if (!this.fastPlane.enabled) return { skipped: "plane off" };
        // Everything pushed since the last pass, plus anything left in the
        // replay log — the log catches what arrived while the subscriber was
        // reconnecting.
        const pushed = this.planeShadowEvents;
        this.planeShadowEvents = [];
        const planeEvents = pushed.concat(await this.fastPlane.drainEvents());
        const brainCrossings = this.recentCrossings;
        this.recentCrossings = [];

        const result = this.fastPlane.reconcile(brainCrossings, planeEvents);
        if (result.onlyPlane.length || result.onlyBrain.length) {
            this.logger?.warn?.("FastPlane", "the two implementations disagreed", {
                onlyPlane: result.onlyPlane.slice(0, 5),
                onlyBrain: result.onlyBrain.slice(0, 5),
            });
        }
        return result;
    }

    // A watched symbol that has stopped ticking is a symbol the reflex lane
    // can no longer protect. Nothing here trades on that: acting on the
    // absence of data is how a system talks itself into a decision it cannot
    // support. It is recorded, escalated for armed symbols, and surfaced in
    // health so the operator sees it rather than inferring it.
    async staleSweep() {
        this.metrics.staleSweeps += 1;
        const now = this.clock().getTime();
        const previous = this.lastStaleSweepAt;
        this.lastStaleSweepAt = now;

        // The sweep is gated to the trading window, so it resumes at the open
        // after a gap, and again after a halt or a restart. Silence that
        // accumulated while nobody was listening is not evidence of anything.
        //
        // The gap is judged against the sweep's own cadence, not against the
        // staleness threshold: the question is whether the sweep was running,
        // and a sweep that missed several of its own intervals was not.
        const resumptionGapMs = Math.max(this.staleSweepMs * 5, 5_000);
        if (previous === null || now - previous > resumptionGapMs) {
            const rearmed = this.reflex.resetSilence(now);
            return { stale: 0, resumed: true, rearmed };
        }

        const stale = this.reflex.newlyStale(now, this.staleAfterMs);
        if (!stale.length) return { stale: 0 };

        for (const entry of stale) {
            if (entry.armed) this.metrics.blindSymbols += 1;
            await this.raiseStaleEvent(entry, this.reflex.commitmentFor(entry.symbol));
        }
        this.logger?.warn?.("Reflex", "watched symbols have gone quiet",
                            { symbols: stale.map((s) => s.symbol),
                              armed: stale.filter((s) => s.armed).length });
        this.narrate(KIND.STALE_DATA, {
            symbols: stale.map((s) => s.symbol).slice(0, 20),
            count: stale.length,
            armed: stale.filter((s) => s.armed).length,
            oldestAgeMs: Math.max(...stale.map((s) => s.ageMs)),
        });
        return { stale: stale.length };
    }

    async raiseStaleEvent(entry, commitment) {
        try {
            const at = this.clock();
            const event = makeEvent({
                type: EVENT_TYPES.DATA_STALE,
                // An armed symbol going quiet means a pre-committed stop is
                // unguarded. That is not the same as a watchlist name going
                // quiet, and the severity should not pretend otherwise.
                severity: entry.armed ? SEVERITY.CRITICAL : SEVERITY.WARNING,
                symbol: entry.symbol,
                thesisId: commitment?.thesisId ?? null,
                correlationId: commitment?.correlationId ?? `stale-${entry.symbol}`,
                source: "reflex_lane",
                observed: { ageMs: entry.ageMs, armed: entry.armed, ticked: entry.ticked,
                            lastPaise: entry.lastPaise, detector: "stale_sweep_v1" },
                reason: entry.ticked
                    ? `no tick for ${entry.symbol} in ${Math.round(entry.ageMs / 1000)}s`
                    : `no tick for ${entry.symbol} since the watch began`,
                observedAt: at,
                bucket: Math.floor(at.getTime() / 60_000),
            });
            return await this.sourcePorts.recordEvent?.(event);
        } catch (err) {
            this.logger?.error?.("Reflex", "could not raise the staleness event",
                                 { error: err.message, symbol: entry.symbol });
            return null;
        }
    }

    // Every tick, from the websocket. Synchronous and allocation-light: this
    // runs hundreds of times a second across the universe.
    ingestTick({ symbol, price, timestamp, volume }) {
        if (!symbol || !Number.isFinite(price)) return [];
        return this.reflex.onTick({
            symbol, pricePaise: Math.round(price * 100),
            at: timestamp ?? this.clock().getTime(),
            // Cumulative for the session as the feed reports it; the lane takes
            // the delta inside the current minute.
            cumulativeVolume: Number.isFinite(volume) ? volume : null,
        });
    }

    // Load the pre-commitments of everything currently held.
    //
    // Idempotent, and safe to run repeatedly: a symbol already armed is left
    // exactly as it is, because re-arming would clear its latches and re-fire
    // a level it has already acted on. Only a holding nothing is watching is
    // picked up. That makes this both the recovery path at start and the
    // periodic audit that catches a position which lost its cover mid-session.
    async armOpenPositions() {
        const positions = (await this.sourcePorts.loadPositions?.(this.clock())) ?? [];
        let armed = 0;
        // Real capital with nothing watching it is the most dangerous state
        // this system can be in. It was inferable — `armed` came back smaller
        // than `positions` — and inferable is not reported.
        const unprotected = [];
        for (const position of positions) {
            // Already covered. Touching it would reset the latches on levels it
            // has already crossed.
            if (this.reflex.isArmed(position.symbol)) { armed += 1; continue; }

            if (!position.thesisId) {
                unprotected.push({ symbol: position.symbol, quantity: position.quantity,
                                   reason: "no open thesis" });
                continue;
            }
            const ok = this.reflex.arm(position.symbol, {
                thesisId: position.thesisId,
                direction: position.side === "SELL" ? DIRECTION.SHORT : DIRECTION.LONG,
                stopPaise: position.stopPaise ?? null,
                targetPaise: position.targetPaise ?? null,
                quantity: position.quantity,
                correlationId: position.correlationId,
            });
            // Continuous detection needs the entry price for the approach
            // bands, and it is the entry that makes those bands meaningful.
            if (ok) {
                const watch = {
                    entryPaise: position.entryPricePaise,
                    thesisId: position.thesisId,
                    correlationId: position.correlationId,
                    direction: position.side === "SELL" ? DIRECTION.SHORT : DIRECTION.LONG,
                };
                this.reflex.watch(position.symbol, watch);
                // The plane is told the same thing, in the same order.
                this.fastPlane.arm(position.symbol, {
                    thesisId: String(position.thesisId),
                    direction: watch.direction,
                    stopPaise: position.stopPaise ?? null,
                    targetPaise: position.targetPaise ?? null,
                    quantity: position.quantity,
                    correlationId: position.correlationId ?? "",
                });
                this.fastPlane.watch(position.symbol, { entryPaise: watch.entryPaise,
                    thesisId: String(position.thesisId ?? ""),
                    correlationId: position.correlationId ?? "",
                    direction: watch.direction });
                armed += 1;
            } else {
                // The lane refuses a commitment with nothing to test, which is
                // right: you cannot protect a level that does not exist.
                unprotected.push({ symbol: position.symbol, quantity: position.quantity,
                                   reason: "the thesis records no stop or target" });
            }
        }

        // Reported when it CHANGES, not on every pass. This runs on a timer, and
        // repeating the same warning every thirty seconds would push the events
        // an operator actually needs out of the cockpit's ring buffer.
        const signature = unprotected.map((p) => `${p.symbol}:${p.reason}`).sort().join("|");
        const changed = signature !== this.unprotectedSignature;
        this.unprotected = unprotected;
        this.unprotectedSignature = signature;
        this.metrics.unprotectedPositions = unprotected.length;

        if (changed && unprotected.length) {
            this.logger?.error?.("Runtime", "open positions that nothing is protecting",
                                 { positions: unprotected });
            this.narrate(KIND.PROTECTION, {
                state: "UNPROTECTED",
                symbols: unprotected.map((p) => p.symbol),
                positions: unprotected,
                because: "these positions carry capital with no level protecting them",
            });
        } else if (changed && this.unprotectedSignature !== "") {
            this.logger?.info?.("Runtime", "every open position is protected again");
        }
        return { armed, positions: positions.length, unprotected };
    }

    // The pre-committed action. No model, no queue, no poll: the decision was
    // made when the thesis was written and the risk gate approved the position
    // those levels belong to. The engine remains the authority on whether the
    // sell is possible at all.
    async protect(crossing) {
        const { symbol, kind, quantity, thesisId, correlationId, pricePaise } = crossing;

        // Only a crossing of a pre-committed level authorises a protective
        // action. Everything else is a material change: it wakes the trader
        // immediately rather than waiting for the supervisory sweep, and it
        // does not move the position by itself.
        if (!isProtective(kind)) {
            this.metrics.materialSignals += 1;
            const route = SIGNAL_ROUTING[kind];
            const routed = typeof route === "function" ? route(crossing) : route;
            if (routed) {
                await this.raiseCrossingEvent(crossing, routed.severity, routed.type);
            }
            this.narrate(KIND.MARKET_EVENT, {
                symbol, type: routed?.type ?? kind, severity: routed?.severity ?? "INFO",
                reason: crossing.reason ?? `${kind} on the tick`,
                detector: "reflex_v1", route: "POSITION", thesisId,
                observed: { kind, pricePaise, levelPaise: crossing.levelPaise ?? null },
            });
            return { protected: false, reason: `${kind} handed to reasoning` };
        }

        this.metrics.protectiveActions += 1;
        // Tier 0. No model was consulted; the thesis pre-committed to this.
        this.narrate(KIND.PROTECTIVE_EVENT, {
            symbol, crossing: kind, pricePaise, levelPaise: crossing.levelPaise ?? null,
            thesisId, correlationId, quantity,
            because: "a level the thesis pre-committed to was crossed",
            modelConsulted: false,
        });

        // Everything from here can fail, and a failure must leave the level
        // armed.
        //
        // The latch is set when the crossing is DETECTED, before anything has
        // acted on it. Anything that threw after that point — reading the
        // position, submitting the order — used to leave the latch set with no
        // exit placed, which silently disarmed a pre-committed stop for the
        // rest of the session while the position stayed open. One failure, one
        // unguarded position, no alarm.
        let size = quantity;
        try {
            // Protection reads the world NOW, never a decision's snapshot: a
            // pre-committed exit must be sized to what is actually held at the
            // instant the level was crossed.
            const position = (await this.sourcePorts.positionFor?.(symbol, this.clock())) ?? null;
            const held = position?.quantity ?? 0;
            if (held <= 0) {
                this.reflex.disarm(symbol);
                this.fastPlane.disarm(symbol);
                return { protected: false, reason: "position already closed" };
            }

            size = Math.min(quantity || held, held);
            await this.executeIntent({
                action: "EXIT", side: "SELL", symbol, quantity: size,
                pricePaise, referencePricePaise: pricePaise,
                correlationId: correlationId ?? `reflex-${symbol}`,
                thesisId,
                // One protective exit per thesis per crossing kind, whatever
                // else is happening elsewhere in the system.
                clientOrderId: `${thesisId ?? symbol}:PROTECT:${kind}`,
            });
            this.metrics.protectiveExits += 1;
            this.reflex.disarm(symbol);
            this.fastPlane.disarm(symbol);
            this.logger?.warn?.("Reflex", "protective exit submitted", {
                symbol, kind, quantity: size, pricePaise });
        } catch (err) {
            this.metrics.protectiveRetries += 1;
            this.reflex.rearm(symbol, kind);
            this.logger?.error?.("Reflex", "protective exit failed; the level stays armed",
                                 { error: err.message, symbol, kind });
            this.narrate(KIND.PROTECTIVE_EVENT, {
                symbol, crossing: kind, pricePaise, thesisId, correlationId,
                quantity: size, failed: true,
                because: "the protective exit could not be submitted; the level stays armed",
                modelConsulted: false,
            });
            return { protected: false, error: err.message, rearmed: true };
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

        const observations = await this.sourcePorts.loadObservations(now);
        const positions = (await this.sourcePorts.loadPositions?.(now)) ?? [];
        const held = new Set(positions.map((p) => p.symbol));

        const result = scanUniverse({
            observations, heldSymbols: held, asOf: now,
            screen: this.screen, calculatedAt: now,
        });

        this.metrics.candidatesScanned += result.examined.length;
        this.metrics.candidatesPassed += result.candidates.length;
        this.metrics.candidatesSuppressed += result.suppressed;

        // Bounded, and sequential only within that bound.
        //
        // This used to reason about every passing candidate in one pass. With a
        // rate-limited model that made the scan job run for minutes — measured
        // at 235 seconds and still in flight — while the event-driven reasoning
        // cycle competed for the same budget. Two paths spending one budget is
        // how both starve.
        //
        // The scan is discovery: it takes the few strongest and lets the next
        // pass, or the event path, pick up the rest.
        const take = result.candidates.slice(0, MAX_SCAN_REASONING);
        for (const candidate of take) {
            await this.handleCandidate({ symbol: candidate.symbol, context: candidate.context,
                                         reasons: candidate.reasons, asOf: now });
        }
        this.metrics.candidatesDeferred += result.candidates.length - take.length;
        return { candidates: result.candidates.length, reasoned: take.length,
                 examined: result.examined.length };
    }

    // A candidate is a different question from a position: "is there enough
    // evidence to establish one" rather than "is the thesis still valid".
    async handleCandidate({ symbol, context = null, event = null, reasons = [],
                            asOf = null, market = null }) {
        if (!this.sourcePorts.analyseCandidate) return { skipped: "no analyser" };
        const session = this.orchestrator.session();
        if (!permits(session, "discovery")) return { skipped: `session ${session}` };

        // Reasoning is a metered resource. Discovery stops before the budget is
        // gone so that positions already carrying capital can still be
        // reassessed for the rest of the session.
        const tokens = tokenBudget();
        if (!tokens.discoveryPermitted) {
            this.metrics.candidatesBudgetSkipped += 1;
            return { skipped: "reasoning budget reserved for open positions" };
        }
        if (discoveryAheadOfPace(tokens, this.clock())) {
            this.metrics.candidatesPaced += 1;
            return { skipped: "spending ahead of the session's reasoning pace" };
        }

        // Arithmetic before reasoning. A move that cannot pay for its own round
        // trip has no executable thesis in it, so asking the model costs two
        // calls to be told what the cost hurdle already says. This is the same
        // economic question the scan path has always asked; the event path
        // never asked it.
        const economics = clearsCostHurdle(context ?? market ?? null);
        if (!economics.worth) {
            this.metrics.candidatesBelowCostHurdle += 1;
            return { skipped: economics.reason };
        }

        const now = (asOf ?? this.clock()).getTime();
        const last = this.lastCandidateReasoningAt.get(symbol);
        if (last !== undefined && now - last < CANDIDATE_COOLDOWN_MS) {
            this.metrics.candidatesCooledDown += 1;
            return { skipped: "reasoned about recently; nothing new to price" };
        }

        // The scan job and the reasoning job can both arrive here for the same
        // symbol within seconds of each other.
        const release = this.gate.acquire(symbol, "candidate");
        if (!release) {
            this.metrics.candidatesGated += 1;
            return { skipped: "symbol already being reasoned about" };
        }
        try {
            // Stamped before the decision, not after: two passes must not both
            // pay because the first had not finished. Written through to the
            // store as well, so a restart does not forget what it just paid for.
            this.lastCandidateReasoningAt.set(symbol, now);
            this.sourcePorts.markCandidateReasoned?.(symbol, now)?.catch?.(() => {});
            return await this.decideCandidate({ symbol, context, event, reasons, session,
                                                asOf: asOf ?? this.clock(), market });
        } finally {
            release();
        }
    }

    async decideCandidate({ symbol, context, event, reasons, asOf = this.clock(), market = null }) {
        const correlationId = `cand-${randomUUID()}`;
        this.metrics.candidateReasoning += 1;

        // One journal entry per outcome, every outcome. The identity of the
        // decision and the world it was taken in are the same for all of them,
        // so they are bound once here rather than repeated at each exit.
        const record = (fields) => this.sourcePorts.journal?.({
            decisionId: correlationId, correlationId, symbol, route: "CANDIDATE",
            event, context, reasons, asOf, ...fields });

        // G4. One instant for this decision. Every read below is bound to it,
        // except the Tier 4 revalidation, which must be fresh by definition.
        const decision = await this.sourcePorts.analyseCandidate({
            symbol, context, event, reasons, correlationId, asOf,
            market: market ?? this.orchestrator.marketState,
        });

        if (!decision || decision.action !== "BUY") {
            await record({ decision, risk: null, executed: false });
            return { action: decision?.action ?? null, executed: false, journaled: true };
        }

        const price = context?.price ?? null;
        if (!Number.isFinite(price)) {
            await record({ decision, risk: null, executed: false,
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
            clientOrderId: entryIntentKey({ symbol, action: "BUY", at: asOf, epoch }),
        };

        // Tier 4. The decision was formed from `context`; the world may have
        // moved while the model was thinking. Executing against the snapshot is
        // the failure this prevents.
        const observation = {
            pricePaise: Math.round(price * 100),
            atMs: context?.asOf ? new Date(context.asOf).getTime() : asOf.getTime(),
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
            await record({ decision, risk: null, executed: false,
                           blocked: `revalidation ${check.code}: ${check.reason}` });
            return { action: "BUY", executed: false, blocked: check.code, journaled: true };
        }
        const intent = check.intent;

        const portfolio = await this.sourcePorts.loadPortfolio(asOf);
        const risk = evaluateRisk(intent, {
            portfolio, nowMs: world.nowMs ?? asOf.getTime(),
            stale: Boolean(context?.stale),
            session: (await this.sourcePorts.sessionCounters?.()) ?? {},
            openClientOrderIds: (await this.sourcePorts.openClientOrderIds?.()) ?? [],
            // Undefined rather than 0 when the port is absent: the gate fails
            // closed on a count it cannot establish, which is the point of it.
            ambiguousOrders: await this.sourcePorts.ambiguousOrderCount?.(),
        });

        if (risk.decision !== DECISION.ALLOW) {
            await record({ decision, risk, executed: false, intent });
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
            this.reflex.watch(symbol, {
                entryPaise: intent.pricePaise, thesisId: thesis.id,
                correlationId, direction: DIRECTION.LONG,
            });
            this.fastPlane.arm(symbol, {
                thesisId: String(thesis.id), direction: DIRECTION.LONG,
                stopPaise: thesis.stop_paise === null || thesis.stop_paise === undefined
                    ? null : Number(thesis.stop_paise),
                targetPaise: thesis.target_paise === null || thesis.target_paise === undefined
                    ? null : Number(thesis.target_paise),
                quantity: intent.quantity, correlationId,
            });
            this.fastPlane.watch(symbol, { entryPaise: intent.pricePaise,
                thesisId: String(thesis.id), correlationId, direction: DIRECTION.LONG });
        }

        await record({ decision, risk, executed: true, intent,
                       thesisId: thesis?.id ?? null });
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
        // Listen BEFORE arming, so a crossing on a position armed a moment
        // later cannot arrive while nothing is subscribed.
        if (this.fastPlane.enabled) {
            try {
                await this.fastPlane.listen((event) => this.onPlaneEvent(event));
            } catch (err) {
                this.logger?.error?.("Runtime", "could not listen to the fast plane",
                                     { error: err.message, mode: this.fastPlane.mode });
            }
        }
        // What was already reasoned about recently. Without this a restart
        // re-pays for every symbol inside the cooldown window.
        const cooldowns = (await this.sourcePorts.loadCandidateCooldowns?.()) ?? [];
        for (const [symbol, at] of cooldowns) this.lastCandidateReasoningAt.set(symbol, at);
        if (cooldowns.length) {
            this.logger?.info?.("Runtime", "resumed candidate cooldowns",
                                { symbols: cooldowns.length });
        }

        const started = await this.orchestrator.start();

        // Orders the previous process left resting. Without this they are in
        // the database but in nobody's hands: never advanced, never expired,
        // and holding a cash reservation for the rest of the account's life.
        const adopted = await this.venue.adopt(await this.engine.openOrders(this.userId));
        if (adopted) {
            this.metrics.ordersAdopted += adopted;
            this.logger?.warn?.("Runtime", "resumed orders left resting by the last process",
                                { count: adopted });
        }

        const armed = await this.armOpenPositions();
        this.narrate(KIND.RECOVERY, {
            session: this.orchestrator.session(),
            mode: this.mode,
            armedPositions: armed.armed,
            positions: armed.positions,
            unprotectedPositions: armed.unprotected,
            adoptedOrders: adopted,
            recovery: this.orchestrator.recovery,
            fastPlane: this.fastPlane.mode,
        });
        return started;
    }
    async stop() {
        await this.fastPlane.stop();
        return this.orchestrator.stop();
    }

    health() {
        return {
            mode: this.mode,
            liveExecutionEnabled: false,
            orchestrator: this.orchestrator.health(),
            venue: this.venue.health(),
            reflex: this.reflex.health(),
            gate: this.gate.health(),
            fastPlane: this.fastPlane.health(),
            // Reported so a session that cannot reason says so, rather than
            // emitting safe HOLDs that read as judgements.
            model: modelBudget(),
            // Named, not counted: an operator needs to know WHICH position is
            // uncovered, and needs to see it on every heartbeat rather than
            // only in the line printed at recovery.
            unprotectedPositions: this.unprotected,
            reasoning: {
                cooldownMs: CANDIDATE_COOLDOWN_MS,
                sessionProgress: Number(sessionProgress(this.clock()).toFixed(3)),
                aheadOfPace: discoveryAheadOfPace(tokenBudget(), this.clock()),
            },
            runtime: { ...this.metrics },
        };
    }
}
