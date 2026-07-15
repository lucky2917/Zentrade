import { exponentialDecay } from "@zentrade/kernel";

/**
 * Outcome-weighted retrieval (M15) — semantics `retrieval_v1`, FROZEN:
 * changing any weight, quota, or tiebreak below requires a new semantics id.
 *
 * Retrieval laws:
 *  - retrieved memories are historical observations, never advice; ranking
 *    reads memory, it never writes, summarizes, or rewrites it
 *  - outcome weighting means INFORMATIVENESS, not success: a decisive stop
 *    scores exactly like a decisive target. Preferring wins would curate a
 *    survivorship-biased memory and teach the brain to repeat mistakes.
 *  - contradictory memories (same setup, opposite outcomes) must both be
 *    retrievable; resolving contradictions is reasoning's job, not recall's
 *  - total order everywhere: score DESC, decisionDate DESC, memoryKey ASC.
 *    memoryKey is the final bytewise tiebreak, so two replays can never
 *    disagree, even on identical scores.
 *  - diversity: at most one episode per decision; at least ceil(limit/4)
 *    stops and targets each when available (anti-echo-chamber quotas)
 *  - budget: never more than MAX_RETRIEVAL memories per query
 */

export const RETRIEVAL_SEMANTICS = "retrieval_v1" as const;
export const MAX_RETRIEVAL = 8;

const HALF_LIFE_DAYS = 90;
const WEIGHT_MATCH = 0.5;
const WEIGHT_RECENCY = 0.3;
const WEIGHT_OUTCOME = 0.2;
const MATCH_SYMBOL = 0.5;
const MATCH_REGIME = 0.3;
const MATCH_ACTION = 0.1;
const MATCH_MODE = 0.1;

export interface RetrievalQuery {
    symbol?: string;
    regime?: string;
    action?: string;
    mode?: string;
}

export interface RetrievalCandidate {
    memoryKey: string;
    decisionId: string;
    horizon: string;
    symbol: string;
    venue: string;
    action: string;
    mode: string;
    confidence: string;
    regime: string;
    hit: string;
    basis: string;
    realizedReturnBps: number | null;
    decisionDate: string;
}

export interface RankedMemory extends RetrievalCandidate {
    score: number;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

const matchScore = (m: RetrievalCandidate, q: RetrievalQuery): number =>
    (q.symbol && m.symbol === q.symbol ? MATCH_SYMBOL : 0) +
    (q.regime && m.regime === q.regime ? MATCH_REGIME : 0) +
    (q.action && m.action === q.action ? MATCH_ACTION : 0) +
    (q.mode && m.mode === q.mode ? MATCH_MODE : 0);

const outcomeInformativeness = (hit: string): number => (hit === "target" || hit === "stop" ? 1 : 0.5);

const ageDays = (asOf: string, decisionDate: string): number =>
    Math.max(0, Math.round((Date.parse(asOf) - Date.parse(decisionDate)) / 86_400_000));

export const scoreMemory = (m: RetrievalCandidate, q: RetrievalQuery, asOf: string): number =>
    round6(
        WEIGHT_MATCH * matchScore(m, q) +
            WEIGHT_RECENCY * exponentialDecay(ageDays(asOf, m.decisionDate), HALF_LIFE_DAYS) +
            WEIGHT_OUTCOME * outcomeInformativeness(m.hit),
    );

const totalOrder = (a: RankedMemory, b: RankedMemory): number => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.decisionDate !== b.decisionDate) return a.decisionDate < b.decisionDate ? 1 : -1;
    return a.memoryKey < b.memoryKey ? -1 : 1;
};

const dedupeByDecision = (ranked: readonly RankedMemory[]): RankedMemory[] => {
    const seen = new Set<string>();
    const out: RankedMemory[] = [];
    for (const m of ranked) {
        if (seen.has(m.decisionId)) continue;
        seen.add(m.decisionId);
        out.push(m);
    }
    return out;
};

export const rankMemories = (
    candidates: readonly RetrievalCandidate[],
    query: RetrievalQuery,
    asOf: string,
    limit: number = MAX_RETRIEVAL,
): RankedMemory[] => {
    const cap = Math.max(1, Math.min(limit, MAX_RETRIEVAL));
    const ranked = dedupeByDecision(
        candidates.map((m) => ({ ...m, score: scoreMemory(m, query, asOf) })).sort(totalOrder),
    );

    const quota = Math.ceil(cap / 4);
    const guaranteed = new Map<string, RankedMemory>();
    for (const hit of ["stop", "target"]) {
        for (const m of ranked.filter((r) => r.hit === hit).slice(0, quota)) {
            guaranteed.set(m.memoryKey, m);
        }
    }
    const overflow = guaranteed.size > cap;
    const picked = overflow ? [...guaranteed.values()].sort(totalOrder).slice(0, cap) : [...guaranteed.values()];
    if (!overflow) {
        for (const m of ranked) {
            if (picked.length >= cap) break;
            if (!guaranteed.has(m.memoryKey)) picked.push(m);
        }
    }
    return picked.sort(totalOrder);
};
