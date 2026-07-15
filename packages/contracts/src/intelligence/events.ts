import { z } from "zod";
import { defineEvent } from "../envelope/envelope.js";
import { Confidence } from "../common/enums.js";
import { Venue } from "../common/instrument.js";

/**
 * intel.decision.published v1 — a decision was journaled (M7).
 * Monetary levels are integer minor units in the instrument's currency.
 * The journal row is the source of truth; this event announces it.
 */
export const DecisionAction = z.enum(["BUY", "SELL", "HOLD"]);
export type DecisionAction = z.infer<typeof DecisionAction>;

export const IntelDecisionPublishedPayloadV1 = z.strictObject({
    decisionId: z.uuid(),
    requestId: z.uuid(),
    instrumentId: z.uuid(),
    venue: Venue,
    symbol: z.string().min(1).max(32),
    action: DecisionAction,
    mode: z.enum(["INTRADAY", "DELIVERY"]),
    confidence: Confidence,
    currency: z.string().length(3),
    entryMinor: z.int().nullable(),
    targetMinor: z.int().nullable(),
    stopMinor: z.int().nullable(),
    agentRunCount: z.int().nonnegative(),
    /** M8 (additive-optional): journal ids of the evidence bundle rows */
    evidenceIds: z.array(z.uuid()).max(64).optional(),
});
export type IntelDecisionPublishedPayloadV1 = z.infer<typeof IntelDecisionPublishedPayloadV1>;

export const IntelDecisionPublishedV1 = defineEvent("intel.decision.published", 1, IntelDecisionPublishedPayloadV1);
export const INTEL_DECISION_PUBLISHED = { type: "intel.decision.published", v: 1 } as const;
