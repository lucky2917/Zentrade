import { rankMemories, buildEpisode, RETRIEVAL_SEMANTICS, MAX_RETRIEVAL } from "@zentrade/domain-memory";
import { istDateString } from "@zentrade/kernel";
import { metrics } from "@zentrade/observability";
import { pool } from "../config/db.js";

/**
 * Memory Retrieval (M15) — recall, never rewrite.
 *
 * Read-only by law: this module contains no write statements at all.
 * Retrieved memories are historical observations projected verbatim from
 * the index, with narratives regenerated (not stored, not summarized) from
 * journal facts by the frozen episodic_v1 template.
 *
 * Replay eligibility rule (retrieval_v1): a memory is retrievable as of a
 * date when its decision_date is strictly BEFORE that date. True
 * availability lagged further by the labeling horizon (an intraday outcome
 * exists next session, a 5d outcome five sessions later); we accept that
 * bounded approximation because it is deterministic forever, while
 * labeled_at timestamps are operational and would not replay.
 *
 * Candidate rule (retrieval_v1): the 500 most recent eligible memories
 * matching symbol OR regime, ordered (decision_date DESC, memory_key ASC).
 */

const CANDIDATE_LIMIT = 500;

const CANDIDATE_SQL = `
    SELECT memory_key, decision_id, request_id, horizon, symbol, venue, action, mode,
           confidence, regime, hit, basis, realized_return_bps, decision_date::text AS decision_date
    FROM memories
    WHERE (symbol = $1 OR regime = $2) AND decision_date < $3
    ORDER BY decision_date DESC, memory_key ASC
    LIMIT ${CANDIDATE_LIMIT}
`;

const STANCES_SQL = `
    SELECT request_id, ARRAY(
        SELECT ar.output->>'signal' FROM agent_runs ar
        WHERE ar.request_id = r.request_id AND ar.status = 'ok' AND ar.agent_name <> 'synthesizer'
        ORDER BY ar.agent_name
    ) AS stances
    FROM unnest($1::uuid[]) AS r(request_id)
`;

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
    realizedReturnBps: row.realized_return_bps === null ? null : Number(row.realized_return_bps),
    decisionDate: row.decision_date,
});

export const retrieveMemories = async ({ symbol, regime, action, mode, asOf, limit } = {}) => {
    if (!symbol && !regime) {
        throw new Error("retrieval requires at least a symbol or a regime");
    }
    const effectiveAsOf = asOf ?? istDateString(new Date());
    const started = performance.now();

    const { rows } = await pool.query(CANDIDATE_SQL, [symbol ?? null, regime ?? null, effectiveAsOf]);
    const requestIdByKey = new Map(rows.map((r) => [r.memory_key, r.request_id]));

    const query = { symbol, regime, action, mode };
    const ranked = rankMemories(rows.map(toCandidate), query, effectiveAsOf, limit ?? MAX_RETRIEVAL);

    const requestIds = ranked.map((m) => requestIdByKey.get(m.memoryKey));
    const stancesByRequest = new Map();
    if (requestIds.length > 0) {
        const { rows: stanceRows } = await pool.query(STANCES_SQL, [requestIds]);
        for (const r of stanceRows) stancesByRequest.set(r.request_id, r.stances);
    }

    const memories = ranked.map((m) => ({
        ...m,
        narrative: buildEpisode({
            decisionId: m.decisionId,
            horizon: m.horizon,
            symbol: m.symbol,
            venue: m.venue,
            action: m.action,
            mode: m.mode,
            confidence: m.confidence,
            regime: m.regime,
            decisionDate: m.decisionDate,
            basis: m.basis,
            hit: m.hit,
            realizedReturnBps: m.realizedReturnBps,
            stances: stancesByRequest.get(requestIdByKey.get(m.memoryKey)) ?? [],
        }).narrative,
    }));

    metrics.gauge("memory.last_retrieval_ms").set(Math.round(performance.now() - started));
    return { semantics: RETRIEVAL_SEMANTICS, asOf: effectiveAsOf, query, memories };
};
