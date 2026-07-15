import { z } from "zod";
import { defineEvent } from "../envelope/envelope.js";

/**
 * md.regime.labeled v1 — a trading session was classified (M12).
 * Labels are immutable per (venue, calDate, taxonomy); a revised taxonomy
 * publishes NEW rows under a new taxonomy id, never rewrites.
 */
export const MdRegimeLabeledPayloadV1 = z.strictObject({
    venue: z.string().min(1).max(16),
    calDate: z.iso.date(),
    taxonomy: z.string().min(1).max(32),
    trend: z.enum(["UP", "DOWN", "SIDEWAYS"]),
    volBucket: z.enum(["LOWVOL", "MIDVOL", "HIGHVOL"]),
    breadth: z.string().max(16).nullable(),
    composite: z.string().min(1).max(48),
    inputsHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type MdRegimeLabeledPayloadV1 = z.infer<typeof MdRegimeLabeledPayloadV1>;

export const MdRegimeLabeledV1 = defineEvent("md.regime.labeled", 1, MdRegimeLabeledPayloadV1);
export const MD_REGIME_LABELED = { type: "md.regime.labeled", v: 1 } as const;
