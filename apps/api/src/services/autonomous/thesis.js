import { pool } from "../../config/db.js";

// The entry thesis: why a position exists and what would make it wrong.
//
// Rows are immutable by database trigger — only closed_at and close_reason may
// change. A reassessment is a new row in position_reassessments referencing
// the thesis, never an edit. Without that the system could rewrite its own
// history and mark itself right after the fact.

export const HORIZONS = ["INTRADAY", "SWING", "POSITIONAL"];

export class ThesisRejected extends Error {}

// A thesis that cannot be falsified is not a thesis. Entry is refused rather
// than recording something the monitor can never evaluate.
export const validateThesis = (input) => {
    const problems = [];
    if (!input.symbol) problems.push("symbol is required");
    if (!["BUY", "SELL"].includes(input.side)) problems.push("side must be BUY or SELL");
    if (!Number.isInteger(input.entryPricePaise) || input.entryPricePaise <= 0)
        problems.push("entryPricePaise must be a positive integer");
    if (!Number.isInteger(input.quantity) || input.quantity <= 0)
        problems.push("quantity must be a positive integer");
    if (!input.rationale?.trim()) problems.push("rationale is required");
    if (!input.setupType?.trim()) problems.push("setupType is required");
    if (!Array.isArray(input.invalidationConditions) || input.invalidationConditions.length === 0)
        problems.push("at least one invalidation condition is required");
    if (!HORIZONS.includes(input.horizon))
        problems.push(`horizon must be one of ${HORIZONS.join(", ")}`);
    if (!input.correlationId?.trim()) problems.push("correlationId is required");
    return problems;
};

export const recordThesis = async (input) => {
    const problems = validateThesis(input);
    if (problems.length) throw new ThesisRejected(problems.join("; "));

    const { rows } = await pool.query(`
        INSERT INTO trade_thesis (
            user_id, symbol, correlation_id, side, entry_price_paise, quantity,
            rationale, setup_type, invalidation_conditions, supporting_evidence,
            stop_paise, target_paise, horizon, risk_note, market_regime, session_phase
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16)
        ON CONFLICT (user_id, symbol, correlation_id) DO NOTHING
        RETURNING *`,
        [input.userId, input.symbol, input.correlationId, input.side,
         input.entryPricePaise, input.quantity, input.rationale, input.setupType,
         JSON.stringify(input.invalidationConditions),
         JSON.stringify(input.supportingEvidence ?? []),
         input.stopPaise ?? null, input.targetPaise ?? null, input.horizon,
         input.riskNote ?? null, input.marketRegime ?? null, input.sessionPhase ?? null]);

    if (rows.length) return rows[0];

    // Idempotent: the same correlation id must not create a second thesis.
    const existing = await pool.query(
        "SELECT * FROM trade_thesis WHERE user_id=$1 AND symbol=$2 AND correlation_id=$3",
        [input.userId, input.symbol, input.correlationId]);
    return existing.rows[0];
};

export const openThesisFor = async (userId, symbol) => {
    const { rows } = await pool.query(
        `SELECT * FROM trade_thesis
         WHERE user_id=$1 AND symbol=$2 AND closed_at IS NULL
         ORDER BY opened_at DESC LIMIT 1`, [userId, symbol]);
    return rows[0] ?? null;
};

export const closeThesis = async (thesisId, reason) => {
    const { rows } = await pool.query(
        `UPDATE trade_thesis SET closed_at = NOW(), close_reason = $2
         WHERE id = $1 AND closed_at IS NULL RETURNING *`, [thesisId, reason]);
    return rows[0] ?? null;
};

export const recordReassessment = async (input) => {
    const { rows } = await pool.query(`
        INSERT INTO position_reassessments (
            thesis_id, event_id, correlation_id, action, confidence,
            thesis_still_valid, what_changed, material, reasoning, evidence,
            unrealised_pnl_paise, current_price_paise, holding_seconds,
            risk_decision, risk_reason, executed
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16)
        RETURNING *`,
        [input.thesisId, input.eventId ?? null, input.correlationId, input.action,
         input.confidence, input.thesisStillValid, input.whatChanged, input.material,
         input.reasoning, JSON.stringify(input.evidence ?? []),
         input.unrealisedPnlPaise, input.currentPricePaise, input.holdingSeconds,
         input.riskDecision ?? null, input.riskReason ?? null, input.executed ?? false]);
    return rows[0];
};

export const reassessmentsFor = async (thesisId) => {
    const { rows } = await pool.query(
        "SELECT * FROM position_reassessments WHERE thesis_id=$1 ORDER BY created_at ASC",
        [thesisId]);
    return rows;
};
