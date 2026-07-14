import { z } from "zod";
import { defineEvent } from "../envelope/envelope.js";
import { AssetClass } from "../common/enums.js";
import { Venue } from "../common/instrument.js";

/**
 * ref.instrument.added v1 — a new instrument entered the registry (M5).
 * Emitted transactionally with the insert; consumers learn the canonical
 * instrumentId that all cognitive records key on from M7 onward.
 */
export const RefInstrumentAddedPayloadV1 = z.strictObject({
    instrumentId: z.uuid(),
    venue: Venue,
    symbol: z.string().min(1).max(32),
    name: z.string().min(1).max(128),
    assetClass: AssetClass,
    currency: z.string().length(3),
});
export type RefInstrumentAddedPayloadV1 = z.infer<typeof RefInstrumentAddedPayloadV1>;

export const RefInstrumentAddedV1 = defineEvent("ref.instrument.added", 1, RefInstrumentAddedPayloadV1);
export const REF_INSTRUMENT_ADDED = { type: "ref.instrument.added", v: 1 } as const;
