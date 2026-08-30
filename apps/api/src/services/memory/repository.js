import { pool } from "../../config/db.js";
import { rankMemories, MAX_RETRIEVAL, RETRIEVAL_SEMANTICS } from "@zentrade/domain-memory";
import { TIER, makeEvidence } from "../reasoning/evidence.js";

// Episodic memory on the decision path.
//
// M11-M17 built the whole chain — outcome labelling, regimes, calibration,
// episodic memory, retrieval, reflection — and then nothing read it. The brain
// remembered everything and consulted none of it, so it began every session as
// naive as its first.
//
// This connects retrieval to reasoning, and only retrieval. The rules that make
// it safe are not relaxed:
//
//   - eligibility is strictly BEFORE the decision's instant, so a memory can
//     never contain the outcome of the decision it is informing
//   - memories are OBSERVATIONS, never advice: the brain is shown what happened
//     and resolves contradictions itself
//   - ranking is retrieval_v1, unchanged, in the domain package
//   - a failure here degrades the decision, it does not fail it

const CANDIDATE_LIMIT = 500;

// The candidate window the domain ranker scores. Bounded because ranking is
// pure and cheap but the table grows forever.
const CANDIDATE_SQL = `
    SELECT memory_key, decision_id, horizon, symbol, venue, action, mode,
           confidence, regime, hit, basis, realized_return_bps, decision_date
    FROM memories
    WHERE semantics = $1
      AND decision_date < $2::date
      AND (symbol = $3 OR ($4::text IS NOT NULL AND regime = $4))
    ORDER BY decision_date DESC
    LIMIT ${CANDIDATE_LIMIT}`;

const toCandidate = (row) => ({
    memoryKey: row.memory_key,
    decisionId: row.decision_id,
    horizon: row.horizon,
    symbol: row.symbol,
    venue: row.venue,
    action: row.action,
    mode: row.mode,
    confidence: row.confidence,
    regime: row.regime,
    hit: row.hit,
    basis: row.basis,
    realizedReturnBps: row.realized_return_bps === null
        ? null : Number(row.realized_return_bps),
    decisionDate: row.decision_date instanceof Date
        ? row.decision_date.toISOString().slice(0, 10)
        : String(row.decision_date).slice(0, 10),
});

// The IST session date an instant belongs to. Eligibility is by session, not by
// wall clock, because a decision made at 09:20 IST must not see a memory formed
// from a decision made at 15:20 the same session.
const sessionDateOf = (iso) => {
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;
    return new Date(at.getTime() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
};

export const makeMemoryRetriever = ({ db = pool, logger = null } = {}) =>
    async ({ symbol, regime = null, action = null, mode = "INTRADAY",
             asOf, limit = MAX_RETRIEVAL }) => {
        const sessionDate = sessionDateOf(asOf);
        if (!symbol || !sessionDate) return [];

        const { rows } = await db.query(CANDIDATE_SQL,
            ["episodic_v1", sessionDate, symbol, regime]);
        if (!rows.length) return [];

        const ranked = rankMemories(rows.map(toCandidate),
                                    { symbol, regime, action, mode }, asOf, limit);
        logger?.info?.("Memory", "retrieved", {
            symbol, candidates: rows.length, returned: ranked.length,
            semantics: RETRIEVAL_SEMANTICS });
        return ranked;
    };

// How a memory reaches the brain.
//
// OBSERVATION, not FACT: the outcome is measured, but "this setup behaved this
// way before" is a comparison against a baseline, not a property of now. And
// never INFERENCE, because nothing was inferred — it happened.
export const memoryEvidence = (memories = []) => memories.map((m) => makeEvidence({
    tier: TIER.OBSERVATION,
    source: `memory:${m.memoryKey.slice(0, 12)}`,
    statement: `${m.decisionDate}: ${m.action} ${m.symbol} at ${m.confidence} confidence`
        + ` in a ${m.regime} regime resolved ${m.hit}`,
    value: m.realizedReturnBps === null ? null : `${m.realizedReturnBps} bps`,
}));

// A one-line summary the prompt can carry without listing every episode.
export const summariseMemories = (memories = []) => {
    if (!memories.length) return null;
    const counts = memories.reduce((acc, m) => {
        acc[m.hit] = (acc[m.hit] ?? 0) + 1;
        return acc;
    }, {});
    const parts = Object.entries(counts).sort().map(([hit, n]) => `${n} ${hit}`);
    return `${memories.length} comparable past decision(s): ${parts.join(", ")}`;
};

export { MAX_RETRIEVAL };
