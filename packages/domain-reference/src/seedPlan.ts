/**
 * Seed planning: given what the registry already holds and what the config
 * declares, produce exactly the inserts needed. Pure diff — the seeder
 * (apps side) executes it transactionally. Identity is (venue, symbol).
 */

export interface InstrumentSeed {
    venue: string;
    symbol: string;
    name: string;
    assetClass: string;
    currency: string;
    tickSize: number | null;
    lotSize: number | null;
    metadata: Record<string, unknown>;
}

export interface ExistingInstrument {
    venue: string;
    symbol: string;
}

export interface SeedPlan {
    toInsert: InstrumentSeed[];
}

const key = (venue: string, symbol: string): string => `${venue}:${symbol}`;

export const computeSeedPlan = (
    existing: readonly ExistingInstrument[],
    desired: readonly InstrumentSeed[],
): SeedPlan => {
    const have = new Set(existing.map((e) => key(e.venue, e.symbol)));

    const seen = new Set<string>();
    const toInsert: InstrumentSeed[] = [];
    for (const seed of desired) {
        const k = key(seed.venue, seed.symbol);
        if (seen.has(k)) {
            throw new Error(`duplicate instrument in seed config: ${k}`);
        }
        seen.add(k);
        if (!have.has(k)) toInsert.push(seed);
    }
    return { toInsert };
};
