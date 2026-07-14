import { z } from "zod";
import { Confidence, DecisionAction } from "@zentrade/contracts";

/**
 * Journal record builders (M7). Pure validation/normalization: the repository
 * (apps side) persists exactly what these emit. Anything malformed throws
 * HERE, before a transaction opens — a journal must never contain a row that
 * was "fixed up" on the way in.
 */

/** Rupee price (possibly fractional, e.g. 1748.5) -> integer minor units. */
export const priceToMinor = (rupees: number | null | undefined): number | null => {
    if (rupees === null || rupees === undefined) return null;
    if (typeof rupees !== "number" || !Number.isFinite(rupees) || rupees <= 0) {
        throw new Error(`journal price must be a positive finite number, got ${rupees}`);
    }
    return Math.round(rupees * 100);
};

export const AgentRunRecord = z.strictObject({
    agentName: z.string().min(1).max(64),
    agentVersion: z.string().min(1).max(32),
    modelId: z.string().min(1).max(128),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    output: z.unknown(),
    status: z.enum(["ok", "failed", "invalid"]),
    latencyMs: z.int().nonnegative(),
    promptTokens: z.int().nonnegative().nullable(),
    completionTokens: z.int().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
});
export type AgentRunRecord = z.infer<typeof AgentRunRecord>;

export const DecisionRecord = z.strictObject({
    action: DecisionAction,
    mode: z.enum(["INTRADAY", "DELIVERY"]),
    confidence: Confidence,
    entryMinor: z.int().positive().nullable(),
    targetMinor: z.int().positive().nullable(),
    stopMinor: z.int().positive().nullable(),
    rationale: z.strictObject({
        traderNote: z.string().max(2000).nullable(),
        reasoning: z.array(z.string().max(500)).max(5),
        consensus: z.string().max(32).nullable(),
        macroScore: z.number().nullable(),
    }),
    synthesizerVersion: z.string().min(1).max(32),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;

export const ContextSnapshot = z
    .strictObject({
        price: z.number().positive().nullable(),
        changePercent: z.number().nullable(),
        priceTimestamp: z.int().nullable(),
        marketOpen: z.boolean(),
        inputsHash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .describe("Lean by design: full inputs are hashed, not stored (JSONB bloat rule)");
export type ContextSnapshot = z.infer<typeof ContextSnapshot>;

export const buildAgentRun = (input: unknown): AgentRunRecord => AgentRunRecord.parse(input);
export const buildDecision = (input: unknown): DecisionRecord => DecisionRecord.parse(input);
export const buildContextSnapshot = (input: unknown): ContextSnapshot => ContextSnapshot.parse(input);
