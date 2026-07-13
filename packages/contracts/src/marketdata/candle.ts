import { z } from "zod";

/**
 * Candle — one OHLCV bar as produced by the historical-data adapters today
 * ({ time, open, high, low, close, volume } with epoch-second time).
 * Sanity refinement: high must bound low. Dirty vendor rows fail here — at
 * the boundary — instead of poisoning downstream math.
 */
export const Candle = z
    .strictObject({
        /** epoch seconds (bar open time, venue session time) */
        time: z.int().positive(),
        open: z.number().positive().finite(),
        high: z.number().positive().finite(),
        low: z.number().positive().finite(),
        close: z.number().positive().finite(),
        volume: z.number().nonnegative().finite(),
    })
    .refine((c) => c.high >= c.low, { message: "high must be >= low" });
export type Candle = z.infer<typeof Candle>;

/**
 * Canonical bar resolutions. Adapter-specific codes (Fyers "60", "D", …) are
 * mapped to these at the edge; new resolutions may be added, never renamed.
 */
export const CandleResolution = z.enum(["1m", "5m", "15m", "30m", "60m", "1d", "1w", "1mo"]);
export type CandleResolution = z.infer<typeof CandleResolution>;
