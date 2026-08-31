import { pool } from "../../config/db.js";
import redis from "../../config/redis.js";
import { toPaise } from "../../utils/paise.js";
import {
    SESSION_PHASES as INTELLIGENCE_PHASES, phaseAtMinutes, istMinutesOf,
} from "../intelligence/sessionPhase.js";
import { maxAgeFor, SOURCE } from "../orchestrator/freshness.js";

// The canonical view of what the agent owns.
//
// `portfolio` remains the single source of truth for quantity and average
// price; nothing here duplicates it. This module joins that row to its entry
// thesis and the latest cached tick so the reasoning path can be asked "should
// we keep this?" rather than the discovery question "should we buy this?".
//
// All money is paise. Ticks arrive in rupees and are converted once, here, at
// the boundary. Mixing the two is the obvious way to produce a P&L that is
// wrong by a factor of a hundred.

export const STALE_AFTER_MS = 90_000;

// The same `stock:SYMBOL` key is written by the websocket and by the REST
// market worker on a five-minute timer. Judging both by the streamed bound
// would call a fresh REST quote stale; judging both by the REST bound would let
// a dead websocket look alive for five minutes. The source decides.
export const maxAgeForTick = (tick) =>
    tick?.source === "rest" ? maxAgeFor(SOURCE.REST) : STALE_AFTER_MS;

// Session phase has one definition, in the intelligence layer. This module
// carried a second copy that disagreed with it at exactly 15:30.
export const SESSION_PHASES = INTELLIGENCE_PHASES;
export const sessionPhase = phaseAtMinutes;
export { istMinutesOf };

export const readTick = async (symbol) => {
    const raw = await redis.get(`stock:${symbol}`);
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
};

// Unrealised P&L in paise. Signed by side so a short position profits when
// price falls.
export const unrealisedPnlPaise = ({ side, quantity, entryPricePaise, currentPricePaise }) => {
    const move = currentPricePaise - entryPricePaise;
    return (side === "SELL" ? -move : move) * quantity;
};

export const pnlPercent = ({ side, entryPricePaise, currentPricePaise }) => {
    if (!entryPricePaise) return 0;
    const move = currentPricePaise - entryPricePaise;
    return ((side === "SELL" ? -move : move) / entryPricePaise) * 100;
};

// Distance to a level as a fraction of the entry-to-level span. 0 means the
// level has been reached; 1 means price is still at entry. Null when the
// thesis recorded no such level.
export const distanceToLevel = (currentPaise, entryPaise, levelPaise) => {
    if (levelPaise === null || levelPaise === undefined) return null;
    const span = levelPaise - entryPaise;
    if (span === 0) return 0;
    // `+ 0` normalises -0, which Object.is distinguishes from 0 and which
    // would otherwise surprise any threshold comparison downstream.
    return (levelPaise - currentPaise) / span + 0;
};

export const buildPositionState = ({ holding, thesis, tick, now }) => {
    const currentPricePaise = tick ? toPaise(tick.price) : null;
    const observedAt = tick?.timestamp ? new Date(tick.timestamp) : null;
    const ageMs = observedAt ? now.getTime() - observedAt.getTime() : null;
    const stale = ageMs === null || ageMs > maxAgeForTick(tick);

    const side = thesis?.side ?? "BUY";
    const entryPricePaise = Number(holding.avg_price_paise);
    const quantity = Number(holding.quantity);

    const base = {
        symbol: holding.symbol,
        userId: holding.user_id,
        side,
        quantity,
        entryPricePaise,
        currentPricePaise,
        exposurePaise: currentPricePaise === null ? null : currentPricePaise * quantity,
        stale,
        dataAgeMs: ageMs,
        sessionPhase: sessionPhase(istMinutesOf(now)),
        thesisId: thesis?.id ?? null,
        correlationId: thesis?.correlation_id ?? null,
        openedAt: thesis?.opened_at ?? null,
        holdingSeconds: thesis?.opened_at
            ? Math.max(0, Math.floor((now.getTime() - new Date(thesis.opened_at).getTime()) / 1000))
            : null,
        stopPaise: thesis?.stop_paise === undefined || thesis?.stop_paise === null
            ? null : Number(thesis.stop_paise),
        targetPaise: thesis?.target_paise === undefined || thesis?.target_paise === null
            ? null : Number(thesis.target_paise),
        hasThesis: Boolean(thesis),
    };

    if (currentPricePaise === null) {
        return { ...base, unrealisedPnlPaise: null, pnlPercent: null,
                 stopDistance: null, targetDistance: null };
    }

    return {
        ...base,
        unrealisedPnlPaise: unrealisedPnlPaise({ side, quantity, entryPricePaise, currentPricePaise }),
        pnlPercent: pnlPercent({ side, entryPricePaise, currentPricePaise }),
        stopDistance: distanceToLevel(currentPricePaise, entryPricePaise, base.stopPaise),
        targetDistance: distanceToLevel(currentPricePaise, entryPricePaise, base.targetPaise),
    };
};

// Every open position with its thesis and latest tick.
//
// SCOPED BY ACCOUNT. Without the user filter this returned every account's
// positions, so one account's holdings would suppress another's discovery and
// the monitor would attempt to reassess positions it does not own.
export const openPositions = async (now = new Date(), userId = null) => {
    const { rows } = await pool.query(`
        SELECT p.user_id, p.symbol, p.quantity, p.avg_price_paise,
               t.id, t.correlation_id, t.side, t.opened_at,
               t.stop_paise, t.target_paise, t.rationale, t.setup_type,
               t.invalidation_conditions, t.supporting_evidence, t.horizon
        FROM portfolio p
        LEFT JOIN trade_thesis t
          ON t.user_id = p.user_id AND t.symbol = p.symbol AND t.closed_at IS NULL
        WHERE p.quantity > 0
          AND ($1::int IS NULL OR p.user_id = $1)
        ORDER BY p.symbol
    `, [userId]);

    const states = [];
    for (const row of rows) {
        const tick = await readTick(row.symbol);
        const thesis = row.id ? {
            id: row.id, correlation_id: row.correlation_id, side: row.side,
            opened_at: row.opened_at, stop_paise: row.stop_paise,
            target_paise: row.target_paise, rationale: row.rationale,
            setup_type: row.setup_type,
            invalidation_conditions: row.invalidation_conditions,
            supporting_evidence: row.supporting_evidence, horizon: row.horizon,
        } : null;
        states.push(buildPositionState({
            holding: {
                user_id: row.user_id, symbol: row.symbol,
                quantity: row.quantity, avg_price_paise: row.avg_price_paise,
            },
            thesis, tick, now,
        }));
    }
    return states;
};

// Portfolio-level state. A symbol can look attractive on its own and still be
// refused because the book should not take more exposure.
export const portfolioState = async (userId, now = new Date()) => {
    const positions = await openPositions(now, userId);
    const { rows } = await pool.query("SELECT balance_paise FROM users WHERE id = $1", [userId]);
    const cashPaise = rows.length ? Number(rows[0].balance_paise) : 0;

    const priced = positions.filter((p) => p.exposurePaise !== null);
    const grossExposurePaise = priced.reduce((sum, p) => sum + Math.abs(p.exposurePaise), 0);
    const netExposurePaise = priced.reduce(
        (sum, p) => sum + (p.side === "SELL" ? -p.exposurePaise : p.exposurePaise), 0);
    const unrealisedPnlPaise = positions.reduce((sum, p) => sum + (p.unrealisedPnlPaise ?? 0), 0);

    return {
        userId,
        cashPaise,
        positionCount: positions.length,
        positions,
        grossExposurePaise,
        netExposurePaise,
        unrealisedPnlPaise,
        equityPaise: cashPaise + grossExposurePaise + unrealisedPnlPaise,
        stalePositions: positions.filter((p) => p.stale).length,
        positionsWithoutThesis: positions.filter((p) => !p.hasThesis).length,
    };
};
