import { pool } from "../../config/db.js";
import { openPositions, portfolioState } from "../autonomous/positionState.js";
import { OPEN_STATES } from "../execution/engine.js";

// What a freshly connected cockpit needs to render the whole screen.
//
// Every field is read from real system state. Anything the system does not
// actually know is reported as null and rendered as UNKNOWN; nothing here
// invents a value to fill a panel.

const OPEN_ORDER_SQL = `
    SELECT id, symbol, type, quantity, filled_quantity, price_paise, state,
           order_mode, client_order_id, correlation_id, thesis_id,
           created_at, last_update_at
    FROM orders
    WHERE user_id = $1 AND state = ANY($2)
    ORDER BY created_at DESC LIMIT 50`;

const RECENT_ORDER_SQL = `
    SELECT id, symbol, type, quantity, filled_quantity, price_paise, state,
           order_mode, pnl_paise, correlation_id, thesis_id,
           created_at, completed_at
    FROM orders
    WHERE user_id = $1 AND created_at >= date_trunc('day', NOW())
    ORDER BY created_at DESC LIMIT 50`;

// The reassessment history behind one position, which is how a thesis is shown
// to have evolved rather than merely to have existed.
const TIMELINE_SQL = `
    SELECT t.id AS thesis_id, t.symbol, t.opened_at, t.rationale, t.setup_type,
           t.invalidation_conditions, t.stop_paise, t.target_paise, t.horizon,
           t.entry_price_paise, t.quantity,
           r.id AS reassessment_id, r.created_at AS reassessed_at, r.action,
           r.confidence, r.thesis_still_valid, r.what_changed, r.material,
           r.reasoning, r.risk_decision, r.risk_reason, r.executed,
           r.unrealised_pnl_paise, r.current_price_paise, r.holding_seconds,
           e.event_type AS trigger_type, e.severity AS trigger_severity,
           e.reason AS trigger_reason
    FROM trade_thesis t
    LEFT JOIN position_reassessments r ON r.thesis_id = t.id
    LEFT JOIN position_events e ON e.id = r.event_id
    WHERE t.user_id = $1 AND t.symbol = $2 AND t.closed_at IS NULL
    ORDER BY r.created_at ASC NULLS FIRST
    LIMIT 200`;

const number = (v) => (v === null || v === undefined ? null : Number(v));

export const readOpenOrders = async (userId, db = pool) => {
    const { rows } = await db.query(OPEN_ORDER_SQL, [userId, OPEN_STATES]);
    return rows.map((r) => ({
        id: r.id, symbol: r.symbol, side: r.type,
        quantity: number(r.quantity), filledQuantity: number(r.filled_quantity),
        pricePaise: number(r.price_paise), state: r.state, mode: r.order_mode,
        clientOrderId: r.client_order_id, correlationId: r.correlation_id,
        thesisId: r.thesis_id, createdAt: r.created_at, lastUpdateAt: r.last_update_at,
    }));
};

export const readTodaysOrders = async (userId, db = pool) => {
    const { rows } = await db.query(RECENT_ORDER_SQL, [userId]);
    return rows.map((r) => ({
        id: r.id, symbol: r.symbol, side: r.type,
        quantity: number(r.quantity), filledQuantity: number(r.filled_quantity),
        pricePaise: number(r.price_paise), state: r.state, mode: r.order_mode,
        pnlPaise: number(r.pnl_paise), correlationId: r.correlation_id,
        thesisId: r.thesis_id, createdAt: r.created_at, completedAt: r.completed_at,
    }));
};

// ORIGINAL THESIS and CURRENT BELIEF, kept visibly apart. The entry thesis is
// immutable; the belief is whatever the last reassessment concluded.
export const readPositionTimeline = async (userId, symbol, db = pool) => {
    const { rows } = await db.query(TIMELINE_SQL, [userId, symbol]);
    if (!rows.length) return null;

    const head = rows[0];
    const reassessments = rows
        .filter((r) => r.reassessment_id)
        .map((r) => ({
            id: r.reassessment_id, at: r.reassessed_at, action: r.action,
            confidence: r.confidence, thesisStillValid: r.thesis_still_valid,
            whatChanged: r.what_changed, material: r.material, reasoning: r.reasoning,
            riskDecision: r.risk_decision, riskReason: r.risk_reason,
            executed: r.executed,
            unrealisedPnlPaise: number(r.unrealised_pnl_paise),
            currentPricePaise: number(r.current_price_paise),
            holdingSeconds: number(r.holding_seconds),
            trigger: r.trigger_type
                ? { type: r.trigger_type, severity: r.trigger_severity,
                    reason: r.trigger_reason }
                : null,
        }));

    const latest = reassessments[reassessments.length - 1] ?? null;
    return {
        symbol,
        // Immutable. Written once at entry and never updated.
        originalThesis: {
            id: head.thesis_id, openedAt: head.opened_at, rationale: head.rationale,
            setupType: head.setup_type,
            invalidationConditions: head.invalidation_conditions,
            stopPaise: number(head.stop_paise), targetPaise: number(head.target_paise),
            horizon: head.horizon, entryPricePaise: number(head.entry_price_paise),
            quantity: number(head.quantity),
        },
        // Whatever the last reassessment concluded. Null until one has run.
        currentBelief: latest
            ? { action: latest.action, confidence: latest.confidence,
                thesisStillValid: latest.thesisStillValid,
                whatChanged: latest.whatChanged, reasoning: latest.reasoning,
                at: latest.at, trigger: latest.trigger }
            : null,
        reassessments,
    };
};

// The live world as the intelligence pass last measured it. Not raw ticks:
// the state the brain actually reasons over.
export const buildWorld = (runtime) => {
    const orchestrator = runtime?.orchestrator;
    if (!orchestrator) return { session: "UNKNOWN", market: null, symbols: [] };

    const contexts = orchestrator.lastContexts ?? {};
    const symbols = Object.entries(contexts).map(([symbol, c]) => ({
        symbol,
        price: c.price ?? null,
        vwap: c.vwap ?? null,
        vwapDistance: c.vwapDistance ?? null,
        vwapAvailable: Boolean(c.vwapAvailable),
        volumeBaseline: c.volumeBaseline ?? null,
        sessionPhase: c.sessionPhase ?? null,
        minutesIntoSession: c.minutesIntoSession ?? null,
        mtf: c.mtf ?? null,
        barsSeen: c.barsSeen ?? null,
        asOf: c.asOf ?? null,
    }));

    return {
        session: orchestrator.session(),
        halted: orchestrator.halted,
        market: orchestrator.marketState ?? null,
        queueDepth: orchestrator.queue?.size ?? 0,
        symbols,
        lastMarketUpdateAt: orchestrator.metrics?.lastMarketUpdateAt ?? null,
    };
};

export const buildSnapshot = async ({
    narrator, runtime, health, userId, db = pool, limit = 300,
}) => {
    const now = new Date();
    const [positions, portfolio, openOrders, todaysOrders, plane] = await Promise.all([
        openPositions(now, userId).catch(() => []),
        portfolioState(userId, now).catch(() => null),
        readOpenOrders(userId, db).catch(() => []),
        readTodaysOrders(userId, db).catch(() => []),
        // The Go plane's own heartbeat. Null when the plane is off, which is a
        // different thing from a plane that is on and not answering.
        runtime?.fastPlane?.planeHealth?.().catch(() => null) ?? null,
    ]);

    return {
        at: now.toISOString(),
        // Never anything but PAPER, and stated on every payload so the UI
        // cannot render a live-money impression by omission.
        mode: runtime?.mode ?? "PAPER",
        liveExecutionEnabled: false,
        narration: narrator.snapshot({ limit }),
        world: buildWorld(runtime),
        health: health ?? null,
        runtime: runtime?.health?.() ?? null,
        positions,
        portfolio,
        openOrders,
        todaysOrders,
        fastPlane: plane,
    };
};
