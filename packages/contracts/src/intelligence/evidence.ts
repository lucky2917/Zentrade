import { z } from "zod";

/**
 * Evidence contracts (M8).
 *
 * Evidence = immutable historical observation, assembled BEFORE agents run.
 * Reasoning = interpretation, produced BY agents, referencing evidence only
 * through stable in-bundle refs. The two never mix structurally.
 *
 * `kind` already contains memory/knowledge/analog: M14/M17 plug in as new
 * kinds in this same pipeline, not as new machinery.
 */

export const EvidenceKind = z.enum([
    "price",
    "indicator",
    "intraday",
    "macro",
    "news",
    "memory",
    "knowledge",
    "analog",
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

/** Stable in-bundle reference agents cite, e.g. "ind:rsi14", "news:2". */
export const EVIDENCE_REF_PATTERN = /^[a-z][a-z0-9]*:[a-z0-9_.-]{1,32}$/;
export const EvidenceRef = z.string().regex(EVIDENCE_REF_PATTERN);
export type EvidenceRef = z.infer<typeof EvidenceRef>;

export const EvidenceItem = z.strictObject({
    ref: EvidenceRef,
    kind: EvidenceKind,
    /** provenance of the observation, e.g. "fyers:candles:D:365", "finnhub:company-news" */
    sourceRef: z.string().min(1).max(200),
    content: z.unknown(),
    weight: z.number().min(0).max(1).nullable(),
});
export type EvidenceItem = z.infer<typeof EvidenceItem>;

/** AgentAnalysis v2: every claim cites at least one evidence ref. */
export const AnalystKeyPoint = z.strictObject({
    point: z.string().min(1).max(300),
    refs: z.array(EvidenceRef).min(1).max(8),
});
export type AnalystKeyPoint = z.infer<typeof AnalystKeyPoint>;

export const CitationStatus = z.enum(["ok", "invalid"]);
export type CitationStatus = z.infer<typeof CitationStatus>;
