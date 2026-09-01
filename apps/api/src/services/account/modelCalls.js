import { pool } from "../../config/db.js";
import { sessionDateOf } from "./paperAccount.js";

// The trader's record of what it asked the model.
//
// callGroqSafe already builds this: every call pushes a row into a sink with
// the agent, the model, the status, the latency and the token usage, and the
// pipeline returns the whole sink as `decision.agentRuns`. It was never
// written down, so the only way to count the day's calls was to multiply the
// decisions by two and hope no call had been retried — and a call that failed
// on a rate limit, which is precisely the one worth seeing, left no trace at
// all.
//
// Writing this must never cost a decision: the decision has already been made
// by the time these rows exist, and losing the record of it is much cheaper
// than losing the trade.

export const recordModelCalls = async ({
    userId, runs, decisionId = null, correlationId = null, symbol = null,
    at = new Date(), db = pool, logger = null,
}) => {
    const rows = (runs ?? []).filter((r) => r && r.agentName);
    if (!rows.length) return 0;

    try {
        // One statement for the whole decision's calls. A decision makes two;
        // a round trip each would double the write cost of reasoning.
        const values = [];
        const params = [];
        for (const [i, r] of rows.entries()) {
            const b = i * 12;
            values.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},`
                + `$${b+8},$${b+9},$${b+10},$${b+11},$${b+12})`);
            params.push(
                userId, decisionId, correlationId, sessionDateOf(at), symbol,
                r.agentName, r.modelId ?? "unknown", r.status ?? "unknown",
                Number.isFinite(r.latencyMs) ? Math.round(r.latencyMs) : null,
                r.promptTokens ?? null, r.completionTokens ?? null,
                // The output of a failed call carries the reason it failed;
                // a successful one carries the answer, which is already stored
                // as the decision and is not duplicated here.
                r.status === "ok" ? null
                    : String(r.output?.error ?? r.output ?? "").slice(0, 500));
        }
        const { rowCount } = await db.query(
            `INSERT INTO model_calls (user_id, decision_id, correlation_id, session_date,
                symbol, agent_name, model_id, status, latency_ms, prompt_tokens,
                completion_tokens, error)
             VALUES ${values.join(",")}`, params);
        return rowCount;
    } catch (err) {
        logger?.warn?.("ModelCalls", "model call record not written",
                       { error: err.message, calls: rows.length });
        return 0;
    }
};

// What the day actually spent, and on what.
export const modelCallSummary = async ({ userId, at = new Date(), db = pool } = {}) => {
    const { rows } = await db.query(
        `SELECT agent_name, status, COUNT(*)::int AS calls,
                COALESCE(SUM(prompt_tokens),0)::int AS prompt_tokens,
                COALESCE(SUM(completion_tokens),0)::int AS completion_tokens,
                ROUND(AVG(latency_ms))::int AS avg_latency_ms
         FROM model_calls WHERE user_id=$1 AND session_date=$2
         GROUP BY agent_name, status ORDER BY agent_name, status`,
        [userId, sessionDateOf(at)]);
    return rows;
};

// Calls per minute, which is the number a rate limit is actually judged
// against and the one that had to be inferred before this existed.
export const modelCallRate = async ({ userId, at = new Date(), db = pool } = {}) => {
    const { rows } = await db.query(
        `SELECT to_char(date_trunc('minute', called_at), 'HH24:MI') AS minute,
                COUNT(*)::int AS calls,
                COUNT(*) FILTER (WHERE status <> 'ok')::int AS failed
         FROM model_calls WHERE user_id=$1 AND session_date=$2
         GROUP BY 1 ORDER BY 1`, [userId, sessionDateOf(at)]);
    return rows;
};
