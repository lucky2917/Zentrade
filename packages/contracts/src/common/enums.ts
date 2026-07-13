import { z } from "zod";

/**
 * Shared closed vocabularies. Enum evolution rule: values may be ADDED,
 * never renamed or removed — consumers switch on them and old events
 * containing old values must parse forever.
 */

export const AssetClass = z.enum([
    "equity",
    "index",
    "fx",
    "crypto",
    "commodity",
    "option",
    "future",
    "etf",
]);
export type AssetClass = z.infer<typeof AssetClass>;

export const OrderSide = z.enum(["BUY", "SELL"]);
export type OrderSide = z.infer<typeof OrderSide>;

/** Directional view an analysis can take. Matches today's agent outputs. */
export const Stance = z.enum(["BULLISH", "BEARISH", "NEUTRAL"]);
export type Stance = z.infer<typeof Stance>;

/** Coarse confidence bucket. Calibration (M13) maps these to numbers. */
export const Confidence = z.enum(["HIGH", "MEDIUM", "LOW"]);
export type Confidence = z.infer<typeof Confidence>;

/**
 * Regime placeholder until M12 defines taxonomy `regime_v1`.
 * A regime tag is always paired with the taxonomy that produced it so
 * historical labels survive taxonomy revisions (labels are never rewritten).
 */
export const RegimeTag = z
    .strictObject({
        taxonomy: z.string().min(1),
        label: z.string().min(1),
    })
    .describe("Market regime label, versioned by taxonomy");
export type RegimeTag = z.infer<typeof RegimeTag>;

export const UNLABELED_REGIME: RegimeTag = { taxonomy: "none", label: "unlabeled" };
