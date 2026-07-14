import { z } from "zod";
import { defineEvent } from "../envelope/envelope.js";
import { Candle, CandleResolution } from "./candle.js";
import { Venue } from "../common/instrument.js";

/**
 * md.candle.closed v1 — a completed bar for an instrument.
 * First citizen of the event backbone (M4). Emitted at most once per
 * (symbol, session) by the ingest path; consumers must be idempotent.
 */
export const MdCandleClosedPayloadV1 = z.strictObject({
    venue: Venue,
    symbol: z.string().min(1).max(32),
    resolution: CandleResolution,
    candle: Candle,
});
export type MdCandleClosedPayloadV1 = z.infer<typeof MdCandleClosedPayloadV1>;

export const MdCandleClosedV1 = defineEvent("md.candle.closed", 1, MdCandleClosedPayloadV1);
export const MD_CANDLE_CLOSED = { type: "md.candle.closed", v: 1 } as const;
