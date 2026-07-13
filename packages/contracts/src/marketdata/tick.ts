import { z } from "zod";

/**
 * MarketTick — the canonical normalized quote that crosses the anti-corruption
 * boundary. This schema deliberately mirrors what the SmartWall sanitizer
 * emits TODAY (apps/api sanitiseTick): equity ticks carry the full session
 * block; index ticks carry only price/change fields. Vendor payloads never
 * cross inward; only this shape does.
 *
 * All prices are plain numbers in venue currency units (rupees today) because
 * that is the present reality of the tick path; monetary *ledger* values use
 * kernel Money (M3) — ticks are observations, not bookkeeping.
 */
export const MarketTick = z.strictObject({
    symbol: z.string().min(1).max(32),
    name: z.string().min(1).max(128),
    price: z.number().positive().finite(),
    change: z.number().finite(),
    changePercent: z.number().finite(),
    /** epoch milliseconds, assigned at normalization time */
    timestamp: z.int().positive(),

    // present on equity ticks, absent on index ticks
    open: z.number().nonnegative().finite().optional(),
    previousClose: z.number().nonnegative().finite().optional(),
    dayHigh: z.number().nonnegative().finite().optional(),
    dayLow: z.number().nonnegative().finite().optional(),
    volume: z.number().nonnegative().finite().optional(),
    marketState: z.string().max(32).optional(),
});
export type MarketTick = z.infer<typeof MarketTick>;
