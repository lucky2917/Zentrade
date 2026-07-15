import { canonicalHash } from "@zentrade/kernel";

/**
 * Episode formation (M14) — semantics `episodic_v1`.
 *
 * Memory is an index over experience, not another database. The journal
 * remains the single source of truth: an episode carries REFERENCES and
 * deterministic retrieval keys, never authoritative content.
 *
 * Identity law: memoryKey = canonicalHash({ scope, decisionId, horizon }).
 * The key names a position in experience — one decision, one horizon — and
 * depends on nothing else. No embedding model, no narrative template, no
 * feature evolution can ever change it. Re-embedding or re-featuring under
 * future semantics produces new SIDE data for the same key, never a new key.
 *
 * The narrative is a pure template over journal fields, regenerable
 * verbatim from the journal forever. It is therefore NOT stored — storing
 * it would be duplication; regenerating it is replay.
 */

export const EPISODE_SEMANTICS = "episodic_v1" as const;

export interface EpisodeSource {
    decisionId: string;
    horizon: string;
    symbol: string;
    venue: string;
    action: string;
    mode: string;
    confidence: string;
    regime: string;
    decisionDate: string;
    basis: string;
    hit: string;
    realizedReturnBps: number | null;
    /** ok analyst stances (synthesizer excluded), sorted by agent name */
    stances: readonly string[];
}

export interface Episode {
    memoryKey: string;
    semantics: typeof EPISODE_SEMANTICS;
    narrative: string;
}

export const episodeKey = (decisionId: string, horizon: string): string =>
    canonicalHash({ scope: "episode", decisionId, horizon });

const stanceSummary = (stances: readonly string[]): string => {
    if (stances.length === 0) return "no analyst stances";
    const bulls = stances.filter((s) => s === "BULLISH").length;
    const bears = stances.filter((s) => s === "BEARISH").length;
    return `analysts ${bulls} bullish / ${bears} bearish of ${stances.length}`;
};

const outcomeSummary = (source: EpisodeSource): string => {
    const bps = source.realizedReturnBps === null
        ? "unquantified"
        : `${source.realizedReturnBps >= 0 ? "+" : ""}${source.realizedReturnBps}bps`;
    return `outcome ${source.hit} (${bps}, basis ${source.basis})`;
};

export const buildEpisode = (source: EpisodeSource): Episode => {
    for (const field of ["decisionId", "horizon", "symbol", "action", "regime", "hit"] as const) {
        if (!source[field]) throw new Error(`episode source missing ${field}`);
    }
    const narrative =
        `${source.action} ${source.symbol} (${source.venue}) ${source.mode.toLowerCase()} ` +
        `at ${source.confidence} confidence in ${source.regime} on ${source.decisionDate}; ` +
        `${stanceSummary(source.stances)}; horizon ${source.horizon}: ${outcomeSummary(source)}`;

    return {
        memoryKey: episodeKey(source.decisionId, source.horizon),
        semantics: EPISODE_SEMANTICS,
        narrative,
    };
};
