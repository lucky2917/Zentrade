import { describe, it, expect, beforeAll, afterAll } from "vitest";

/** Regime labeler integration (M12): real Postgres + real Redis. */
const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const DAY = 86_400;
const BASE = Math.floor(Date.UTC(2026, 3, 1, 3, 45) / 1000);
const syntheticProvider = (n = 120) => async () =>
    Array.from({ length: n }, (_, i) => ({ time: BASE + i * DAY, close: 1000 + i * 0.9 + Math.sin(i * 1.7) }));

describe.skipIf(!TEST_DB || !TEST_REDIS)("regime labeler (integration)", () => {
    let pool, redis, labeler;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        redis = (await import("../config/redis.js")).default;
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        const { seedReferenceData } = await import("../services/referenceData.js");
        await seedReferenceData();
        labeler = await import("../services/regimeLabeler.js");
    });

    afterAll(async () => {
        await pool.end();
        redis.disconnect();
    });

    it("backfills every classifiable session once, idempotently, with events", async () => {
        // append-only house rule: assert convergence + deltas, never absolutes
        const rowsBefore = (await pool.query("SELECT COUNT(*)::int AS n FROM regimes WHERE taxonomy = 'nse_equity_v1'")).rows[0].n;
        const eventsBefore = (await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE event_type = 'md.regime.labeled'")).rows[0].n;

        const first = await labeler.backfillRegimes({ candleProvider: syntheticProvider() });
        expect(first.labeled).toBe(70 - rowsBefore); // 120 sessions, window 51 -> converges to 70

        const second = await labeler.backfillRegimes({ candleProvider: syntheticProvider() });
        expect(second.labeled).toBe(0); // idempotent

        const { rows } = await pool.query(
            "SELECT COUNT(*)::int AS n, COUNT(DISTINCT inputs_hash)::int AS hashes FROM regimes WHERE taxonomy = 'nse_equity_v1'"
        );
        expect(rows[0].n).toBe(70);
        expect(rows[0].hashes).toBe(70); // every session hashed its own window

        const eventsAfter = (await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE event_type = 'md.regime.labeled'")).rows[0].n;
        expect(eventsAfter - eventsBefore).toBe(first.labeled); // exactly one per actual insert
    });

    it("labels are append-only: no silent relabeling possible", async () => {
        await expect(pool.query("UPDATE regimes SET composite = 'HACKED'")).rejects.toThrow(/append-only/);
        await expect(pool.query("DELETE FROM regimes")).rejects.toThrow(/append-only/);
        await expect(pool.query("TRUNCATE regimes")).rejects.toThrow(/append-only/);
    });

    it("regimeForDate resolves the effective label for any date (join for history)", async () => {
        const { rows } = await pool.query("SELECT MAX(cal_date)::text AS d FROM regimes");
        const latest = rows[0].d;
        const resolved = await labeler.regimeForDate(latest);
        expect(resolved.taxonomy).toBe("nse_equity_v1");
        expect(resolved.composite).toMatch(/^(UP|DOWN|SIDEWAYS)_(LOW|MID|HIGH)VOL$/);
        // a date after the last label resolves to the last label (effective regime)
        const after = await labeler.regimeForDate("2030-01-01");
        expect(after.cal_date).toBe(latest);
    });

    it("new journal rows are stamped with the current regime tag", async () => {
        const journal = await import("../services/decisionJournal.js");
        const { requestId } = await journal.journalAnalysis({
            symbol: "RELIANCE",
            trigger: "test",
            contextSnapshot: { price: 1500, changePercent: 0, priceTimestamp: 1, marketOpen: false, inputsHash: "d".repeat(64) },
            evidence: [{ ref: "price:live", kind: "price", sourceRef: "test", content: {}, weight: null }],
            runs: [],
            decision: null,
        });
        const { rows } = await pool.query("SELECT regime FROM decision_requests WHERE id = $1", [requestId]);
        expect(rows[0].regime.taxonomy).toBe("nse_equity_v1");
        expect(rows[0].regime.label).toMatch(/^(UP|DOWN|SIDEWAYS)_(LOW|MID|HIGH)VOL$/);
    });

    it("a future taxonomy coexists without touching v1 history", async () => {
        await pool.query(
            `INSERT INTO regimes (venue, cal_date, taxonomy, trend, vol_bucket, composite, inputs_hash)
             SELECT venue, cal_date, 'nse_equity_v2_hypothetical', 'UP', 'LOWVOL', 'UP_LOWVOL', repeat('e', 64)
             FROM regimes WHERE taxonomy = 'nse_equity_v1' LIMIT 1
             ON CONFLICT (venue, cal_date, taxonomy) DO NOTHING`
        );
        const { rows } = await pool.query("SELECT COUNT(DISTINCT taxonomy)::int AS n FROM regimes");
        expect(rows[0].n).toBeGreaterThanOrEqual(2);
    });
});
