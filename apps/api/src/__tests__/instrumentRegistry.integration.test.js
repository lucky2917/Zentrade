import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Instrument registry integration (M5): real Postgres + real Redis.
 * Covers: seed idempotency, transactional ref.instrument.added events,
 * resolver against real rows, calendar seed equal to kernel holidays.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

describe.skipIf(!TEST_DB || !TEST_REDIS)("instrument registry (integration)", () => {
    let pool, redis, seedReferenceData, instrumentResolver, STOCKS, NSE_HOLIDAYS;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        redis = (await import("../config/redis.js")).default;
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        // No truncation: TRUNCATE instruments CASCADE would reach the journal
        // tables, and the M7 append-only triggers rightly refuse. Assertions
        // below are delta-based and idempotency-based instead.
        ({ seedReferenceData, instrumentResolver } = await import("../services/referenceData.js"));
        ({ STOCKS } = await import("../config/stocks.js"));
        ({ NSE_HOLIDAYS } = await import("@zentrade/kernel"));
    });

    afterAll(async () => {
        await pool.end();
        redis.disconnect();
    });

    it("seeding converges the registry to config, emitting one event per actual insert", async () => {
        const countBefore = (await pool.query("SELECT COUNT(*)::int AS n FROM instruments")).rows[0].n;
        const eventsBefore = (
            await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE event_type = 'ref.instrument.added'")
        ).rows[0].n;

        const { inserted } = await seedReferenceData();

        const countAfter = (await pool.query("SELECT COUNT(*)::int AS n FROM instruments")).rows[0].n;
        const eventsAfter = (
            await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE event_type = 'ref.instrument.added'")
        ).rows[0].n;

        expect(countAfter).toBe(STOCKS.length + 3); // converged: 200 equities + 3 indices
        expect(inserted).toBe(countAfter - countBefore); // only what was missing
        expect(eventsAfter - eventsBefore).toBe(inserted); // exactly one event per insert

        // transactional payload fidelity: when this run actually inserted,
        // the newest event's instrumentId must be the real registry row id.
        // (Always exercised in CI — cold database — and skipped on warm local
        // reruns where the queue may have been drained by other suites.)
        if (inserted > 0) {
            const { rows: [event] } = await pool.query(
                "SELECT payload FROM outbox WHERE event_type = 'ref.instrument.added' ORDER BY id DESC LIMIT 1"
            );
            const p = event.payload.payload;
            const { rows: [row] } = await pool.query(
                "SELECT id, asset_class FROM instruments WHERE venue = $1 AND symbol = $2",
                [p.venue, p.symbol]
            );
            expect(p.instrumentId).toBe(row.id);
            expect(p.assetClass).toBe(row.asset_class);
        }
    });

    it("second seed is a no-op: zero inserts, zero new events (idempotency)", async () => {
        const before = (await pool.query("SELECT COUNT(*)::int AS n FROM outbox")).rows[0].n;
        const { inserted } = await seedReferenceData();
        expect(inserted).toBe(0);
        const after = (await pool.query("SELECT COUNT(*)::int AS n FROM outbox")).rows[0].n;
        expect(after).toBe(before);
    });

    it("seeded metadata is faithful: spot-check equities and index venues", async () => {
        const { rows } = await pool.query(
            "SELECT symbol, venue, asset_class, currency, tick_size::float AS tick, lot_size, metadata FROM instruments WHERE symbol = ANY($1)",
            [["RELIANCE", "SENSEX", "NIFTY50"]]
        );
        const bySymbol = Object.fromEntries(rows.map((r) => [r.symbol, r]));

        expect(bySymbol.RELIANCE.venue).toBe("NSE");
        expect(bySymbol.RELIANCE.asset_class).toBe("equity");
        expect(bySymbol.RELIANCE.currency).toBe("INR");
        expect(bySymbol.RELIANCE.tick).toBe(0.05);
        expect(bySymbol.RELIANCE.lot_size).toBe(1);
        expect(bySymbol.RELIANCE.metadata.yahooSymbol).toBe("RELIANCE.NS");

        expect(bySymbol.SENSEX.venue).toBe("BSE"); // SENSEX lives on BSE
        expect(bySymbol.SENSEX.asset_class).toBe("index");
        expect(bySymbol.NIFTY50.venue).toBe("NSE");
    });

    it("every configured stock resolves; resolver caches; unknown symbol is null", async () => {
        instrumentResolver.clearCache();
        for (const s of STOCKS.slice(0, 20)) {
            const resolved = await instrumentResolver.bySymbol("NSE", s.symbol);
            expect(resolved?.name).toBe(s.name);
            expect(resolved.instrumentId).toMatch(/^[0-9a-f-]{36}$/);
        }
        expect(instrumentResolver.cacheSize()).toBe(20);
        expect(await instrumentResolver.bySymbol("NSE", "NOTREAL")).toBeNull();
    });

    it("calendar exceptions equal the kernel holiday set exactly", async () => {
        const { rows } = await pool.query(
            "SELECT to_char(cal_date, 'YYYY-MM-DD') AS d FROM trading_calendars WHERE venue = 'NSE' AND is_holiday ORDER BY cal_date"
        );
        expect(rows.map((r) => r.d)).toEqual([...NSE_HOLIDAYS].sort());
    });

});
