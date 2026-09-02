import { pool } from "../../config/db.js";
import { sessionDateOf, sessionHistory } from "../account/paperAccount.js";

// The whole durable record of a session, in one read.
//
// Everything the trader wrote down: the decisions and the reasoning inside
// them, the model calls those decisions cost, the conditions that woke it, the
// orders and fills, the theses and how they were reassessed, the account's
// day, and the runtime's own comings and goings.
//
// Read only. Every row is something the system persisted at the time; nothing
// here is derived for display, and a value the system does not have arrives as
// null so the page can say UNKNOWN rather than invent one.

const number = (v) => (v === null || v === undefined ? null : Number(v));

export const readLogbook = async ({ userId, sessionDate = null, limit = 400, db = pool }) => {
    const day = sessionDate ?? sessionDateOf(new Date());

    const [decisions, calls, events, orders, fills, theses, reassessments,
           agentEvents, sessions, totals] = await Promise.all([
        db.query(
            `SELECT decision_id, correlation_id, symbol, route, action, confidence,
                    trigger_type, trigger_severity, trigger_reason, evidence, thesis,
                    supporting, contradicting, counter_thesis, alternatives,
                    what_would_change, challenge_verdict, synthesis, risk_decision,
                    risk_code, risk_reason, executed, blocked_reason, thesis_id,
                    price_paise, quantity, decided_at
             FROM decision_records WHERE user_id=$1 AND session_date=$2
             ORDER BY decided_at DESC LIMIT $3`, [userId, day, limit]),
        db.query(
            `SELECT decision_id, correlation_id, symbol, agent_name, model_id, status,
                    latency_ms, prompt_tokens, completion_tokens, error, called_at
             FROM model_calls WHERE user_id=$1 AND session_date=$2
             ORDER BY called_at DESC LIMIT $3`, [userId, day, limit]),
        db.query(
            `SELECT event_key, event_type, severity, symbol, reason, observed, state,
                    attempts, last_error, observed_at, handled_at
             FROM position_events WHERE user_id=$1 AND observed_at >= $2::date AND observed_at < $2::date + 1
             ORDER BY observed_at DESC LIMIT $3`, [userId, day, limit]),
        db.query(
            `SELECT id, symbol, type, quantity, filled_quantity, price_paise,
                    total_value_paise, brokerage_paise, pnl_paise, state, order_mode,
                    client_order_id, correlation_id, rejection_reason, ambiguity_reason,
                    created_at, completed_at
             FROM orders WHERE user_id=$1 AND created_at >= $2::date AND created_at < $2::date + 1
             ORDER BY created_at DESC LIMIT $3`, [userId, day, limit]),
        db.query(
            `SELECT f.order_id, f.execution_ref, f.symbol, f.side, f.quantity,
                    f.price_paise, f.source, f.filled_at
             FROM order_fills f JOIN orders o ON o.id = f.order_id
             WHERE o.user_id=$1 AND f.filled_at >= $2::date AND f.filled_at < $2::date + 1
             ORDER BY f.filled_at DESC LIMIT $3`, [userId, day, limit]),
        db.query(
            `SELECT id, symbol, side, entry_price_paise, quantity, rationale, setup_type,
                    invalidation_conditions, stop_paise, target_paise, horizon,
                    opened_at, closed_at
             FROM trade_thesis WHERE user_id=$1 AND opened_at >= $2::date AND opened_at < $2::date + 1
             ORDER BY opened_at DESC LIMIT $3`, [userId, day, limit]),
        db.query(
            `SELECT r.thesis_id, t.symbol, r.action, r.confidence, r.thesis_still_valid,
                    r.what_changed, r.material, r.reasoning, r.risk_decision,
                    r.risk_reason, r.executed, r.unrealised_pnl_paise,
                    r.current_price_paise, r.holding_seconds, r.created_at
             FROM position_reassessments r JOIN trade_thesis t ON t.id = r.thesis_id
             WHERE t.user_id=$1 AND r.created_at >= $2::date AND r.created_at < $2::date + 1
             ORDER BY r.created_at DESC LIMIT $3`, [userId, day, limit]),
        db.query(
            `SELECT kind, detail, occurred_at FROM agent_events
             WHERE user_id=$1 AND session_date=$2 ORDER BY occurred_at DESC LIMIT $3`,
            [userId, day, limit]),
        sessionHistory({ userId, db }),
        // The true size of the day, independent of the read limit. A page that
        // shows 500 of 1,026 events without saying so is worse than one that
        // shows fewer and admits it.
        db.query(
            `SELECT
               (SELECT COUNT(*)::int FROM decision_records
                 WHERE user_id=$1 AND session_date=$2) AS decisions,
               (SELECT COUNT(*)::int FROM model_calls
                 WHERE user_id=$1 AND session_date=$2) AS model_calls,
               (SELECT COUNT(*)::int FROM position_events
                 WHERE user_id=$1 AND observed_at >= $2::date
                   AND observed_at < $2::date + 1) AS market_events,
               (SELECT COUNT(*)::int FROM orders
                 WHERE user_id=$1 AND created_at >= $2::date
                   AND created_at < $2::date + 1) AS orders,
               (SELECT COUNT(*)::int FROM order_fills f JOIN orders o ON o.id = f.order_id
                 WHERE o.user_id=$1 AND f.filled_at >= $2::date
                   AND f.filled_at < $2::date + 1) AS fills,
               (SELECT COUNT(*)::int FROM trade_thesis
                 WHERE user_id=$1 AND opened_at >= $2::date
                   AND opened_at < $2::date + 1) AS theses,
               (SELECT COUNT(*)::int FROM position_reassessments r
                  JOIN trade_thesis t ON t.id = r.thesis_id
                 WHERE t.user_id=$1 AND r.created_at >= $2::date
                   AND r.created_at < $2::date + 1) AS reassessments,
               (SELECT COUNT(*)::int FROM agent_events
                 WHERE user_id=$1 AND session_date=$2) AS agent_events`,
            [userId, day]),
    ]);

    const counts = totals.rows[0];

    const log = {
        sessionDate: day,
        limit,
        availableDates: sessions.map((r) => r.session_date),
        summary: sessions.find((r) => r.session_date === day) ?? null,
        sessions,
        counts: {
            decisions: counts.decisions, modelCalls: counts.model_calls,
            marketEvents: counts.market_events, orders: counts.orders,
            fills: counts.fills, theses: counts.theses,
            reassessments: counts.reassessments, agentEvents: counts.agent_events,
        },
        decisions: decisions.rows.map((r) => ({
            decisionId: r.decision_id, correlationId: r.correlation_id, symbol: r.symbol,
            route: r.route, action: r.action, confidence: r.confidence,
            trigger: r.trigger_type
                ? { type: r.trigger_type, severity: r.trigger_severity, reason: r.trigger_reason }
                : null,
            evidence: r.evidence, thesis: r.thesis, supporting: r.supporting,
            contradicting: r.contradicting, counterThesis: r.counter_thesis,
            alternatives: r.alternatives, whatWouldChange: r.what_would_change,
            challengeVerdict: r.challenge_verdict, synthesis: r.synthesis,
            risk: r.risk_decision
                ? { decision: r.risk_decision, code: r.risk_code, reason: r.risk_reason }
                : null,
            executed: r.executed, blockedReason: r.blocked_reason, thesisId: r.thesis_id,
            pricePaise: number(r.price_paise), quantity: number(r.quantity),
            at: r.decided_at,
        })),
        modelCalls: calls.rows.map((r) => ({
            decisionId: r.decision_id, correlationId: r.correlation_id, symbol: r.symbol,
            agent: r.agent_name, model: r.model_id, status: r.status,
            latencyMs: number(r.latency_ms), promptTokens: number(r.prompt_tokens),
            completionTokens: number(r.completion_tokens), error: r.error, at: r.called_at,
        })),
        marketEvents: events.rows.map((r) => ({
            key: r.event_key, type: r.event_type, severity: r.severity, symbol: r.symbol,
            reason: r.reason, observed: r.observed, state: r.state,
            attempts: number(r.attempts), lastError: r.last_error,
            at: r.observed_at, handledAt: r.handled_at,
        })),
        orders: orders.rows.map((r) => ({
            id: r.id, symbol: r.symbol, side: r.type, quantity: number(r.quantity),
            filledQuantity: number(r.filled_quantity), pricePaise: number(r.price_paise),
            totalValuePaise: number(r.total_value_paise),
            brokeragePaise: number(r.brokerage_paise), pnlPaise: number(r.pnl_paise),
            state: r.state, mode: r.order_mode, clientOrderId: r.client_order_id,
            correlationId: r.correlation_id,
            rejectionReason: r.rejection_reason, ambiguityReason: r.ambiguity_reason,
            at: r.created_at, completedAt: r.completed_at,
        })),
        fills: fills.rows.map((r) => ({
            orderId: r.order_id, executionRef: r.execution_ref, symbol: r.symbol,
            side: r.side, quantity: number(r.quantity), pricePaise: number(r.price_paise),
            source: r.source, at: r.filled_at,
        })),
        theses: theses.rows.map((r) => ({
            id: r.id, symbol: r.symbol, side: r.side,
            entryPricePaise: number(r.entry_price_paise), quantity: number(r.quantity),
            rationale: r.rationale, setupType: r.setup_type,
            invalidationConditions: r.invalidation_conditions,
            stopPaise: number(r.stop_paise), targetPaise: number(r.target_paise),
            horizon: r.horizon, openedAt: r.opened_at, closedAt: r.closed_at,
        })),
        reassessments: reassessments.rows.map((r) => ({
            thesisId: r.thesis_id, symbol: r.symbol, action: r.action,
            confidence: r.confidence, thesisStillValid: r.thesis_still_valid,
            whatChanged: r.what_changed, material: r.material, reasoning: r.reasoning,
            risk: r.risk_decision
                ? { decision: r.risk_decision, reason: r.risk_reason } : null,
            executed: r.executed,
            unrealisedPnlPaise: number(r.unrealised_pnl_paise),
            currentPricePaise: number(r.current_price_paise),
            holdingSeconds: number(r.holding_seconds), at: r.created_at,
        })),
        agentEvents: agentEvents.rows.map((r) => ({
            kind: r.kind, detail: r.detail, at: r.occurred_at,
        })),
    };

    // What actually came back, so the page can say "500 of 1,026" rather than
    // presenting a truncated day as a complete one.
    log.returned = Object.fromEntries(
        Object.keys(log.counts).map((k) => [k, log[k].length]));
    log.truncated = Object.keys(log.counts)
        .filter((k) => log.returned[k] < log.counts[k]);
    return log;
};
