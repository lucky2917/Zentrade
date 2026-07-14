/**
 * Instrument resolver — maps (venue, symbol) to the canonical registry row.
 *
 * The dual-run shim of M5: existing code keeps speaking symbol strings;
 * journal-bound paths (M7+) resolve to instrument ids at the edge through
 * this. Cache is unbounded-by-TTL on purpose: the registry is append-only
 * and rows are immutable once minted; misses are NOT cached (a symbol may
 * be seeded later).
 */

export interface QueryablePool {
    query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface ResolvedInstrument {
    instrumentId: string;
    venue: string;
    symbol: string;
    name: string;
    assetClass: string;
    currency: string;
}

const SELECT_BY_VENUE_SYMBOL =
    "SELECT id, venue, symbol, name, asset_class, currency FROM instruments WHERE venue = $1 AND symbol = $2";

export const createInstrumentResolver = (pool: QueryablePool) => {
    const cache = new Map<string, ResolvedInstrument>();

    const bySymbol = async (venue: string, symbol: string): Promise<ResolvedInstrument | null> => {
        const key = `${venue}:${symbol}`;
        const hit = cache.get(key);
        if (hit) return hit;

        const { rows } = await pool.query(SELECT_BY_VENUE_SYMBOL, [venue, symbol]);
        const row = rows[0];
        if (!row) return null;

        const resolved: ResolvedInstrument = {
            instrumentId: String(row.id),
            venue: String(row.venue),
            symbol: String(row.symbol),
            name: String(row.name),
            assetClass: String(row.asset_class),
            currency: String(row.currency),
        };
        cache.set(key, resolved);
        return resolved;
    };

    return {
        bySymbol,
        clearCache: () => cache.clear(),
        cacheSize: () => cache.size,
    };
};

export type InstrumentResolver = ReturnType<typeof createInstrumentResolver>;
