import { pool } from "../../config/db.js";
import redis from "../../config/redis.js";
import { openPositions, portfolioState, maxAgeForTick } from "./positionState.js";
import { openThesisFor, recordThesis, recordReassessment } from "./thesis.js";
import { reassessPosition } from "./reassess.js";
import { evaluate as evaluateRisk } from "./riskGate.js";
import { intentFrom } from "./loop.js";
import { eventsForReasoning } from "../news/ingest.js";
import { toPaise } from "../../utils/paise.js";

// The live ports.
//
// Binds the autonomous runtime to real Postgres, real Redis market state and
// the real news store. Everything here is I/O; no domain rule lives in this
// file. It exists so the runtime never has to know where data comes from,
// which is what let the whole loop be tested against fakes first.

const BAR_HISTORY = 60;

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

const readTick = async (symbol) => {
    const raw = await redis.get(`stock:${symbol}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
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

export const buildLivePorts = ({
    userId, newsStore, connectionTracker, ingestNews, universe = [], logger = null,
    callModel = null, analyseCandidate = null,
}) => {
    const ports = {
        loadPositions: async () => openPositions(new Date(), userId),

        loadPortfolio: async () => portfolioState(userId, new Date()),

        positionFor: async (symbol) =>
            (await openPositions(new Date(), userId)).find((p) => p.symbol === symbol) ?? null,

        loadThesis: async (position) => openThesisFor(position.userId ?? userId, position.symbol),

        // Observations for the intelligence layer. Symbols with no cached tick
        // are reported stale rather than omitted, so their staleness is visible
        // instead of looking like an absence of interest.
        loadObservations: async () => {
            const now = Date.now();
            const trusted = Boolean(connectionTracker?.isTrusted?.());
            const positions = await openPositions(new Date(), userId);
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
                    stale: observationStale(tick, now, trusted),
                    dataAgeMs: tickAgeMs(tick, now),
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
                   state       = 'PENDING',
                   leased_until = NULL
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

        pendingNewsEvents: async (now) => {
            const positions = await openPositions(now, userId);
            const thesisBySymbol = new Map(
                positions.filter((p) => p.thesisId).map((p) => [p.symbol, p.thesisId]));
            return eventsForReasoning(newsStore, now, { thesisBySymbol });
        },

        ingestNews,

        reassess: async ({ position, thesis, event, marketState, market }) =>
            reassessPosition({
                position, thesis, event, marketState, market, callModel,
                news: newsStore ? newsStore.visibleAt(new Date().toISOString())
                    .filter((n) => n.symbol === position.symbol).slice(-5) : [],
            }),

        analyseCandidate: analyseCandidate
            ? async (input) => analyseCandidate({
                ...input,
                news: newsStore ? newsStore.visibleAt(new Date().toISOString())
                    .filter((n) => n.symbol === input.symbol).slice(-5) : [],
                portfolio: await portfolioState(userId, new Date()),
            })
            : null,

        intentFrom,

        // Tier 4 input: what is true right now, read at execution time rather
        // than reused from the snapshot the decision was formed on.
        currentWorld: async (symbol) => {
            const now = Date.now();
            const tick = await readTick(symbol);
            const position = (await openPositions(new Date(now), userId))
                .find((p) => p.symbol === symbol) ?? null;
            return {
                nowMs: now,
                pricePaise: tick?.price ? toPaise(tick.price) : null,
                priceAgeMs: tickAgeMs(tick, now),
                position: position ? { quantity: position.quantity } : null,
            };
        },

        evaluateRisk: async (intent) => evaluateRisk(intent, {
            portfolio: await portfolioState(userId, new Date()),
            nowMs: Date.now(),
            stale: !connectionTracker?.isTrusted?.(),
            session: await ports.sessionCounters(),
            openClientOrderIds: await ports.openClientOrderIds(),
        }),

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

        recordReassessment,

        journal: async (entry) => {
            logger?.info?.("Autonomous", "decision", {
                correlationId: entry.correlationId, symbol: entry.symbol ?? entry.event?.symbol,
                action: entry.decision?.action, risk: entry.risk?.decision ?? null,
                riskCode: entry.risk?.code ?? null, executed: entry.executed,
                blocked: entry.blocked ?? null, route: entry.route ?? "POSITION",
            });
            return entry;
        },
    };

    return ports;
};

export { toPaise };
