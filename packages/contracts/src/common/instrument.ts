import { z } from "zod";

/**
 * Instrument identity.
 *
 * InstrumentRef is the canonical forward-looking reference: a UUID minted by
 * the reference-data registry (M5). VenueSymbolRef is the bridge for the
 * pre-registry world (today's code speaks venue+symbol); adapters resolve it
 * to an InstrumentRef at the edge once M5 lands.
 */

export const Venue = z.enum(["NSE", "BSE"]);
export type Venue = z.infer<typeof Venue>;

export const InstrumentRef = z.strictObject({
    instrumentId: z.uuid(),
});
export type InstrumentRef = z.infer<typeof InstrumentRef>;

export const VenueSymbolRef = z.strictObject({
    venue: Venue,
    symbol: z
        .string()
        .min(1)
        .max(32)
        .regex(/^[A-Z0-9&-]+$/, "symbols are uppercase alphanumerics plus & and -"),
});
export type VenueSymbolRef = z.infer<typeof VenueSymbolRef>;
