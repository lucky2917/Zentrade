import { pool } from "../../config/db.js";
import redis from "../../config/redis.js";
import { openPositions, portfolioState, maxAgeForTick, readTick } from "./positionState.js";
import { openThesisFor, recordThesis, recordReassessment } from "./thesis.js";
import { reassessPosition } from "./reassess.js";
import { evaluate as evaluateRisk } from "./riskGate.js";
import { intentFrom } from "./loop.js";
import { eventsForReasoning } from "../news/ingest.js";
import { toPaise } from "../../utils/paise.js";
import { MAX_RETRIEVAL } from "../memory/repository.js";
import { recordDecision, sessionDateOf } from "../account/paperAccount.js";
import { RUNTIME_HALT_KEY } from "../cockpit/narrator.js";

// The live ports.
//
// Binds the autonomous runtime to real Postgres, real Redis market state and
// the real news store. Everything here is I/O; no domain rule lives in this
// file. It exists so the runtime never has to know where data comes from,
// which is what let the whole loop be tested against fakes first.

const BAR_HISTORY = 60;

// How long a condition may be held by one reasoning pass before the store
// assumes the holder is gone. Comfortably longer than the model timeout, so a
// slow decision is never handed out twice.
const EVENT_LEASE_MS = 120_000;

// A condition that has failed this many times is abandoned rather than retried
// forever. Retrying it indefinitely starves everything behind it.
const MAX_EVENT_ATTEMPTS = 5;

// Rolling per-symbol bar history in Redis, appended by the market worker /
// websocket path. Absent history simply means less context, never a guess.
const readBars = async (symbol, granularity) => {
    const raw = await redis.lrange(`bars:${granularity}:${symbol}`, -BAR_HISTORY, -1);
    const bars = [];
    for (const entry of raw ?? []) {
        try {
            const bar = JSON.parse(entry);
            if (Number.isFinite(bar.close)) bars.push(bar);
        } catch { /* skip malformed */ }
    }
    return bars;
};

// A cached tick has no expiry in Redis, so presence is not freshness: Friday's
// close sits in `stock:SYMBOL` all weekend. Age is measured against the same
// bound position state uses, so one rule governs both paths.
const tickAgeMs = (tick, now) => {
    const at = tick?.timestamp ? new Date(tick.timestamp).getTime() : NaN;
    return Number.isFinite(at) ? now - at : null;
};

export const observationStale = (tick, now, connectionTrusted) => {
    if (!tick) return true;
    // A REST quote refreshed while the stream is dead must not read as live.
    if (!connectionTrusted) return true;
    const age = tickAgeMs(tick, now);
    return age === null || age > maxAgeForTick(tick);
};

// G4. One decision, one instant.
//
// Every port used to read the wall clock at its own call time, so the price a
// decision was formed on, the portfolio it was sized against and the world it
// was revalidated in were three different moments. Nothing was wrong by much,
// and nothing was reproducible either.
//
// The clock is injected once and every port takes an explicit `asOf`. A caller
// that holds a decision's instant passes it to every read in that decision, and
// the reads agree by construction. `now()` below is the only fallback, for
// callers with no decision in hand, and this module reads no other clock —
// there is a test that fails if one reappears.
export const buildLivePorts = ({
    userId, newsStore, connectionTracker, ingestNews, universe = [], logger = null,
    callModel = null, analyseCandidate = null, retrieveMemories = null,
    clock = () => new Date(),
}) => {
    const now = (asOf) => (asOf instanceof Date ? asOf : asOf ? new Date(asOf) : clock());

    // News is point-in-time: what was disseminated at or before the decision's
    // instant, never after it. Reading the wall clock here would let a headline
    // that arrived while the model was thinking appear in the evidence for a
    // decision formed before it.
    const visibleNews = (symbol, asOf) => (newsStore
        ? newsStore.visibleAt(now(asOf).toISOString())
            .filter((n) => n.symbol === symbol).slice(-5)
        : []);

    const ports = {
        loadPositions: async (asOf) => openPositions(now(asOf), userId),

        loadPortfolio: async (asOf) => portfolioState(userId, now(asOf)),

        positionFor: async (symbol, asOf) =>
            (await openPositions(now(asOf), userId)).find((p) => p.symbol === symbol) ?? null,

        loadThesis: async (position) => openThesisFor(position.userId ?? userId, position.symbol),

        // Observations for the intelligence layer. Symbols with no cached tick
        // are reported stale rather than omitted, so their staleness is visible
        // instead of looking like an absence of interest.
        loadObservations: async (asOf) => {
            const at = now(asOf);
            const atMs = at.getTime();
            const trusted = Boolean(connectionTracker?.isTrusted?.());
            const positions = await openPositions(at, userId);
            // The operational universe plus everything held. A held symbol is
            // always observed even if it has left the scan universe.
            const symbols = new Set([...universe, ...positions.map((p) => p.symbol)]);
            const observations = [];
            for (const symbol of symbols) {
                const tick = await readTick(symbol);
                const [bars1m, bars5m, bars15m] = await Promise.all([
                    readBars(symbol, "1m"), readBars(symbol, "5m"), readBars(symbol, "15m"),
                ]);
                observations.push({
                    symbol,
                    price: tick?.price ?? null,
                    stale: observationStale(tick, atMs, trusted),
                    dataAgeMs: tickAgeMs(tick, atMs),
                    bars1m, bars5m, bars15m,
                });
            }
            return observations;
        },

        // Persist first, then queue. The row carries the lifecycle: a condition
        // still PENDING is refreshed rather than discarded, so an event that was
        // dropped or expired in the queue comes back on the next observation. A
        // condition already HANDLED returns nothing, which is genuine dedup.
        //
        // Severity is monotonic: a later, milder observation of the same
        // condition can never downgrade what was already recorded.
        recordEvent: async (event) => {
            const { rows } = await pool.query(
                `INSERT INTO position_events
                   (event_key, event_type, severity, symbol, user_id, thesis_id, correlation_id,
                    source, observed, reason, observed_at, state)
                 VALUES ($1,$2,$3,$4,$5,$11,$6,$7,$8::jsonb,$9,$10,'PENDING')
                 ON CONFLICT (event_key) DO UPDATE SET
                   observed_at = EXCLUDED.observed_at,
                   reason      = EXCLUDED.reason,
                   observed    = EXCLUDED.observed,
                   severity    = CASE
                       WHEN EXCLUDED.severity = 'CRITICAL'
                         OR position_events.severity = 'CRITICAL' THEN 'CRITICAL'
                       WHEN EXCLUDED.severity = 'WARNING'
                         OR position_events.severity = 'WARNING'  THEN 'WARNING'
                       ELSE 'INFO' END,
                   -- A condition that recurs while it is being reasoned about
                   -- must not release the lease on it. Resetting to PENDING
                   -- here handed the same row to a second worker: two model
                   -- calls, and two decisions, for one condition.
                   state       = CASE
                       WHEN position_events.state = 'LEASED'
                        AND position_events.leased_until > NOW() THEN 'LEASED'
                       ELSE 'PENDING' END,
                   leased_until = CASE
                       WHEN position_events.state = 'LEASED'
                        AND position_events.leased_until > NOW()
                       THEN position_events.leased_until
                       ELSE NULL END
                 WHERE position_events.state <> 'HANDLED'
                 RETURNING id, severity`,
                [event.key, event.type, event.severity, event.symbol, userId,
                 event.correlationId, event.source, JSON.stringify(event.observed ?? {}),
                 event.reason, event.observedAt, event.thesisId ?? null]);
            return rows[0] ?? null;
        },

        // Restart recovery. Work that was raised but never completed is still
        // in the table; without this it was only ever in memory.
        loadPendingEvents: async (limit = 200) => {
            const { rows } = await pool.query(
                `SELECT id, event_key, event_type, severity, symbol, thesis_id,
                        correlation_id, source, observed, reason, observed_at
                 FROM position_events
                 WHERE user_id = $1 AND state IN ('PENDING','LEASED')
                 ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END,
                          observed_at ASC
                 LIMIT $2`, [userId, limit]);
            return rows.map((r) => ({
                storedId: r.id, key: r.event_key, type: r.event_type, severity: r.severity,
                symbol: r.symbol, thesisId: r.thesis_id, correlationId: r.correlation_id,
                source: r.source, observed: r.observed, reason: r.reason,
                observedAt: r.observed_at instanceof Date ? r.observed_at.toISOString() : r.observed_at,
                recovered: true,
            }));
        },

        // How many entries in this symbol have already completed today. Two
        // concurrent decisions read the same value and therefore build the same
        // intent identity; a genuine re-entry after an exit reads a higher one.
        entryEpoch: async (symbol) => {
            const { rows } = await pool.query(
                `SELECT COUNT(*)::int AS n FROM orders
                 WHERE user_id=$1 AND symbol=$2 AND type='BUY'
                   AND created_at >= date_trunc('day', NOW())`, [userId, symbol]);
            return rows[0].n;
        },

        // Claim work that is durable but not in anyone's hands.
        //
        // The queue is memory. An event it expired or dropped at capacity was
        // returned to the store as PENDING and then sat there: loadPendingEvents
        // only ran at startup, so the condition came back on the next restart or
        // never. This is the in-session half of that, and it is what makes the
        // LEASED state and the attempts counter mean something.
        //
        // A lease that has run out is reclaimed, which is how work survives a
        // process that died holding it.
        claimPendingEvents: async ({ limit = 50, maxAttempts = MAX_EVENT_ATTEMPTS } = {}) => {
            // An event that has failed this many times is not going to succeed
            // by being tried again, and retrying it forever starves everything
            // behind it.
            await pool.query(
                `UPDATE position_events SET state='ABANDONED', leased_until=NULL
                 WHERE user_id=$1 AND state IN ('PENDING','LEASED') AND attempts >= $2`,
                [userId, maxAttempts]);

            const { rows } = await pool.query(
                `SELECT id, event_key, event_type, severity, symbol, thesis_id,
                        correlation_id, source, observed, reason, observed_at
                 FROM position_events
                 WHERE user_id = $1
                   AND (state = 'PENDING'
                        OR (state = 'LEASED' AND leased_until < NOW()))
                 ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END,
                          observed_at ASC
                 LIMIT $2`, [userId, limit]);
            return rows.map((r) => ({
                storedId: r.id, key: r.event_key, type: r.event_type, severity: r.severity,
                symbol: r.symbol, thesisId: r.thesis_id, correlationId: r.correlation_id,
                source: r.source, observed: r.observed, reason: r.reason,
                observedAt: r.observed_at instanceof Date
                    ? r.observed_at.toISOString() : r.observed_at,
                reclaimed: true,
            }));
        },

        // Taken out of the store and into reasoning. The lease is what stops the
        // sweep above handing the same condition to a second worker, and its
        // expiry is what returns the work when a process dies mid-decision.
        leaseEvents: async (eventIds, leaseMs = EVENT_LEASE_MS) => {
            const ids = (eventIds ?? []).filter(Boolean);
            if (!ids.length) return 0;
            const { rowCount } = await pool.query(
                `UPDATE position_events
                 SET state='LEASED',
                     leased_until = NOW() + ($2::bigint * INTERVAL '1 millisecond')
                 WHERE id = ANY($1::uuid[]) AND state <> 'HANDLED'`,
                [ids, leaseMs]);
            return rowCount;
        },

        // The operator's stop, written by the API process. Unreadable is not
        // the same as "not halted": a Redis that cannot be reached must not
        // silently resume a trader the operator stopped, so the last known
        // state stands and the caller is told nothing changed.
        readHaltRequest: async () => {
            try {
                const raw = await redis.get(RUNTIME_HALT_KEY);
                if (!raw) return { halted: false, reason: null };
                const parsed = JSON.parse(raw);
                return { halted: Boolean(parsed.halted), reason: parsed.reason ?? null };
            } catch (err) {
                logger?.warn?.("Autonomous", "could not read the halt request",
                               { error: err.message });
                return null;
            }
        },

        markEventHandled: async (eventId) => {
            if (!eventId) return null;
            const { rows } = await pool.query(
                `UPDATE position_events SET state='HANDLED', handled_at=NOW(), leased_until=NULL
                 WHERE id=$1 AND state <> 'HANDLED' RETURNING id`, [eventId]);
            return rows[0] ?? null;
        },

        markEventFailed: async (eventId, error) => {
            if (!eventId) return null;
            const { rows } = await pool.query(
                `UPDATE position_events
                 SET state='PENDING', leased_until=NULL,
                     attempts = attempts + 1, last_error = $2
                 WHERE id=$1 AND state <> 'HANDLED' RETURNING id, attempts`,
                [eventId, String(error ?? "").slice(0, 500)]);
            return rows[0] ?? null;
        },

        pendingNewsEvents: async (asOf) => {
            const at = now(asOf);
            const positions = await openPositions(at, userId);
            const thesisBySymbol = new Map(
                positions.filter((p) => p.thesisId).map((p) => [p.symbol, p.thesisId]));
            return eventsForReasoning(newsStore, at, { thesisBySymbol });
        },

        ingestNews,

        reassess: async ({ position, thesis, event, marketState, market, asOf }) =>
            reassessPosition({
                position, thesis, event, marketState, market, callModel,
                news: visibleNews(position.symbol, asOf),
                memories: await ports.retrieveMemories({
                    symbol: position.symbol, regime: marketState?.regime ?? null,
                    action: "SELL", asOf }),
            }),

        analyseCandidate: analyseCandidate
            ? async (input) => analyseCandidate({
                ...input,
                news: visibleNews(input.symbol, input.asOf),
                portfolio: await portfolioState(userId, now(input.asOf)),
                memories: await ports.retrieveMemories({
                    symbol: input.symbol, regime: input.market?.regime ?? null,
                    action: "BUY", asOf: input.asOf }),
            })
            : null,

        intentFrom,

        // Tier 4 input: what is true right now, read at execution time rather
        // than reused from the snapshot the decision was formed on.
        // Tier 4 input: what is true right now, read at execution time rather
        // than reused from the snapshot the decision was formed on. This one
        // deliberately takes a FRESH instant by default — revalidation against
        // the decision's own stale timestamp would revalidate nothing.
        currentWorld: async (symbol, asOf) => {
            const at = now(asOf);
            const atMs = at.getTime();
            const tick = await readTick(symbol);
            const position = (await openPositions(at, userId))
                .find((p) => p.symbol === symbol) ?? null;
            return {
                nowMs: atMs,
                pricePaise: tick?.price ? toPaise(tick.price) : null,
                priceAgeMs: tickAgeMs(tick, atMs),
                position: position ? { quantity: position.quantity } : null,
            };
        },

        evaluateRisk: async (intent, _position, asOf) => {
            const at = now(asOf);
            return evaluateRisk(intent, {
                portfolio: await portfolioState(userId, at),
                nowMs: at.getTime(),
                stale: !connectionTracker?.isTrusted?.(),
                session: await ports.sessionCounters(),
                openClientOrderIds: await ports.openClientOrderIds(),
                ambiguousOrders: await ports.ambiguousOrderCount(),
            });
        },

        // Session budgets from today's real orders.
        sessionCounters: async () => {
            const { rows } = await pool.query(
                `SELECT COUNT(*)::int AS trades,
                        COALESCE(SUM(total_value_paise), 0) AS turnover,
                        COALESCE(SUM(CASE WHEN pnl_paise < 0 THEN -pnl_paise ELSE 0 END), 0) AS loss
                 FROM orders
                 WHERE user_id = $1 AND created_at >= date_trunc('day', NOW())`, [userId]);
            return {
                trades: rows[0].trades,
                turnoverPaise: Number(rows[0].turnover),
                realisedLossPaise: Number(rows[0].loss),
            };
        },

        // Orders whose real outcome could not be established. While any exist
        // the system does not know what it owns, so the risk gate refuses new
        // exposure until reconciliation resolves them.
        ambiguousOrderCount: async () => {
            const { rows } = await pool.query(
                `SELECT COUNT(*)::int AS n FROM orders
                 WHERE user_id = $1 AND state = 'AMBIGUOUS'`, [userId]);
            return rows[0].n;
        },

        openClientOrderIds: async () => {
            const { rows } = await pool.query(
                `SELECT client_order_id FROM orders
                 WHERE user_id = $1 AND client_order_id IS NOT NULL
                   AND state IN ('NEW','ACCEPTED','WORKING','PARTIALLY_FILLED','AMBIGUOUS')`,
                [userId]);
            return rows.map((r) => r.client_order_id);
        },

        recordThesis: async ({ symbol, correlationId, decision, context, intent }) => {
            try {
                return await recordThesis({
                    userId, symbol, correlationId, side: intent.side,
                    entryPricePaise: intent.pricePaise, quantity: intent.quantity,
                    rationale: decision.reasoning ?? "autonomous entry",
                    setupType: decision.setupType ?? "unclassified",
                    invalidationConditions: decision.invalidationConditions
                        ?? [`close below ${Math.round(intent.pricePaise * 0.97) / 100}`],
                    supportingEvidence: decision.evidence ?? [],
                    stopPaise: decision.stopPaise ?? Math.round(intent.pricePaise * 0.97),
                    targetPaise: decision.targetPaise ?? Math.round(intent.pricePaise * 1.05),
                    horizon: decision.horizon ?? "INTRADAY",
                    marketRegime: context?.mtf?.aligned ? "aligned" : "mixed",
                    sessionPhase: context?.sessionPhase ?? null,
                });
            } catch (err) {
                // A thesis that cannot be recorded must stop the entry: a
                // position with no thesis cannot ever be reassessed.
                logger?.error?.("LivePorts", "thesis rejected, entry aborted",
                                { error: err.message, symbol });
                throw err;
            }
        },

        // What happened the last times a decision like this one was made.
        //
        // Memories are OBSERVATIONS, never advice: the brain is told what
        // occurred and resolves any contradiction itself. Eligibility is
        // strictly before the decision's instant, so a memory cannot contain
        // its own outcome.
        retrieveMemories: async ({ symbol, regime = null, action = null, asOf,
                                   mode = "INTRADAY", limit = MAX_RETRIEVAL } = {}) => {
            if (!retrieveMemories) return [];
            try {
                return await retrieveMemories({
                    symbol, regime, action, mode, limit, asOf: now(asOf).toISOString() });
            } catch (err) {
                // Memory is context, not a dependency. Losing it degrades the
                // decision; failing the decision because of it would be worse.
                logger?.warn?.("LivePorts", "memory retrieval failed",
                               { error: err.message, symbol });
                return [];
            }
        },

        recordReassessment,

        // Every decision the runtime reaches, durable and auditable — including
        // the ones that produced no order, which are most of them. A rejected
        // candidate whose reasoning is gone is indistinguishable afterwards
        // from a candidate that was never considered.
        //
        // What is stored is the structured reasoning the pipeline already
        // exposes: evidence, thesis, the challenge and its verdict, the
        // alternatives, the synthesis, the risk outcome and what happened. No
        // model chain-of-thought is requested or written.
        journal: async (entry) => {
            const symbol = entry.symbol ?? entry.event?.symbol;
            const decision = entry.decision ?? {};
            logger?.info?.("Autonomous", "decision", {
                correlationId: entry.correlationId, symbol,
                action: decision.action, risk: entry.risk?.decision ?? null,
                riskCode: entry.risk?.code ?? null, executed: entry.executed,
                blocked: entry.blocked ?? null, route: entry.route ?? "POSITION",
            });

            // A journal write must never cost a decision. The decision has
            // already been taken by the time we get here; losing the record is
            // bad, and failing the trade because of it is worse.
            try {
                await recordDecision({ userId, record: {
                    // The decision's own identity. The correlation is the
                    // thread it belongs to and is deliberately not unique.
                    decisionId: entry.decisionId ?? entry.correlationId,
                    correlationId: entry.correlationId,
                    sessionDate: sessionDateOf(now(entry.asOf)),
                    symbol, route: entry.route ?? "POSITION",
                    triggerType: entry.event?.type ?? (entry.reasons?.length ? "screen" : null),
                    triggerSeverity: entry.event?.severity ?? null,
                    triggerReason: entry.reasons?.length
                        ? entry.reasons.join("; ") : (entry.event?.reason ?? null),
                    action: decision.action ?? "NONE",
                    confidence: decision.confidence ?? null,
                    evidence: decision.evidence ?? [],
                    thesis: decision.reasoning ?? null,
                    supporting: decision.supportingEvidence ?? [],
                    contradicting: decision.contradictingEvidence ?? [],
                    counterThesis: decision.challenge?.counterThesis ?? null,
                    alternatives: decision.alternativeHypotheses ?? [],
                    whatWouldChange: decision.whatWouldChangeMyMind ?? [],
                    challengeVerdict: decision.challenge?.verdict ?? null,
                    synthesis: {
                        setupType: decision.setupType ?? null,
                        horizon: decision.horizon ?? null,
                        quantity: decision.quantity ?? null,
                        stopPaise: decision.stopPaise ?? null,
                        targetPaise: decision.targetPaise ?? null,
                        riskReward: decision.riskReward ?? null,
                        edge: decision.edge ?? null,
                        expectedValue: decision.expectedValue ?? null,
                        opportunityCost: decision.opportunityCost ?? null,
                        uncertainty: decision.uncertainty ?? null,
                        marketRegime: decision.marketRegime ?? null,
                        downgraded: decision.downgraded ?? null,
                        fallback: Boolean(decision.fallback),
                    },
                    riskDecision: entry.risk?.decision ?? null,
                    riskCode: entry.risk?.code ?? null,
                    riskReason: entry.risk?.reason ?? null,
                    executed: Boolean(entry.executed),
                    blockedReason: entry.blocked ?? null,
                    thesisId: entry.thesisId ?? null,
                    pricePaise: entry.intent?.pricePaise
                        ?? (Number.isFinite(entry.context?.price)
                            ? Math.round(entry.context.price * 100) : null),
                    quantity: entry.intent?.quantity ?? decision.quantity ?? null,
                    decidedAt: now(entry.asOf),
                }});
            } catch (err) {
                logger?.error?.("Autonomous", "decision journal write failed",
                                { correlationId: entry.correlationId, error: err.message });
            }
            return entry;
        },
    };

    return ports;
};

export { toPaise };
