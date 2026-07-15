import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Outcome labeler integration (M11): real Postgres + real Redis.
 * Decisions are inserted directly (append-only rows cannot be backdated
 * after the fact — created_at is set AT insert, mirroring the repo SQL).
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const DAY = 86_400;
const bar = (base, dayOffset, o, h, l, c) => ({ time: base + dayOffset * DAY, open: o, high: h, low: l, close: c });

describe.skipIf(!TEST_DB || !TEST_REDIS)("outcome labeler (integration)", () => {
    let pool, redis, labeler;
    const made = {}; // symbol -> { decisionId, createdAtEpoch }

    const insertDecision = async ({ symbol, mode, action, entry, target, stop, daysAgo }) => {
        const inst = (await pool.query("SELECT id FROM instruments WHERE venue='NSE' AND symbol=$1", [symbol])).rows[0];
        const req = (
            await pool.query(
                `INSERT INTO decision_requests (instrument_id, requested_by, correlation_id, context_snapshot, created_at)
                 VALUES ($1, 'test', gen_random_uuid(), '{}', NOW() - ($2 || ' days')::interval) RETURNING id, created_at`,
                [inst.id, String(daysAgo)]
            )
        ).rows[0];
        await pool.query(
            `INSERT INTO evidence (request_id, ref, kind, source_ref, content) VALUES ($1, 'price:live', 'price', 'test', '{}')`,
            [req.id]
        );
        const dec = (
            await pool.query(
                `INSERT INTO decisions (request_id, instrument_id, action, mode, confidence, entry_minor, target_minor, stop_minor, rationale, synthesizer_version, correlation_id, created_at)
                 VALUES ($1, $2, $3, $4, 'MEDIUM', $5, $6, $7, '{}', 'v4.1.0', gen_random_uuid(), $8) RETURNING id, created_at`,
                [req.id, inst.id, action, mode, entry, target, stop, req.created_at]
            )
        ).rows[0];
        return { decisionId: dec.id, createdAt: new Date(dec.created_at) };
    };

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        redis = (await import("../config/redis.js")).default;
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        const { seedReferenceData } = await import("../services/referenceData.js");
        await seedReferenceData();
        labeler = await import("../services/outcomeLabeler.js");

        // WIPRO: delivery BUY 10 days ago; candles hit the target on day 2
        made.WIPRO = await insertDecision({ symbol: "WIPRO", mode: "DELIVERY", action: "BUY", entry: 100_000, target: 105_000, stop: 97_000, daysAgo: 10 });
        // VEDL: delivery BUY 1 hour ago — nothing post-decision exists yet
        made.VEDL = await insertDecision({ symbol: "VEDL", mode: "DELIVERY", action: "BUY", entry: 50_000, target: 52_000, stop: 49_000, daysAgo: 0 });
    });

    afterAll(async () => {
        await pool.end();
        redis.disconnect();
    });

    const providerFor = () => {
        const wiproBase = Math.floor(made.WIPRO.createdAt.getTime() / 1000);
        return async (symbol) => {
            if (symbol === "WIPRO") {
                return [
                    bar(wiproBase, 0, 1000, 1090, 995, 1010), // decision session: contaminated high — must not count
                    bar(wiproBase, 1, 1010, 1030, 1005, 1020), // day1: no hit
                    bar(wiproBase, 2, 1020, 1055, 1015, 1048), // day2: target 1050 touched
                    bar(wiproBase, 3, 1048, 1060, 1040, 1052),
                    bar(wiproBase, 4, 1052, 1058, 1046, 1050),
                    bar(wiproBase, 5, 1050, 1056, 1044, 1049),
                ];
            }
            return []; // VEDL: no data yet
        };
    };

    it("labels ready horizons, leaves the rest pending, and is idempotent", async () => {
        const first = await labeler.labelPendingOutcomes({ candleProvider: providerFor() });
        expect(first.labeled).toBeGreaterThanOrEqual(2); // WIPRO 1d + 5d

        const { rows } = await pool.query("SELECT horizon, basis, hit, exit_minor, realized_return_bps, sessions_used FROM outcomes WHERE decision_id = $1 ORDER BY horizon", [made.WIPRO.decisionId]);
        expect(rows).toEqual([
            // 1d: full window (day1) exists, no hit -> close basis at 1020
            { horizon: "1d", basis: "close", hit: "neither", exit_minor: "102000", realized_return_bps: 200, sessions_used: 1 },
            // 5d: target touched on day2 (decision-session high ignored) -> path
            { horizon: "5d", basis: "path", hit: "target", exit_minor: "105000", realized_return_bps: 500, sessions_used: 2 },
        ]);

        // VEDL has no post-decision candles: pending, no rows
        const vedl = await pool.query("SELECT COUNT(*)::int AS n FROM outcomes WHERE decision_id = $1", [made.VEDL.decisionId]);
        expect(vedl.rows[0].n).toBe(0);

        // idempotency: a second pass adds nothing
        const before = (await pool.query("SELECT COUNT(*)::int AS n FROM outcomes")).rows[0].n;
        const second = await labeler.labelPendingOutcomes({ candleProvider: providerFor() });
        expect(second.labeled).toBe(0);
        const after = (await pool.query("SELECT COUNT(*)::int AS n FROM outcomes")).rows[0].n;
        expect(after).toBe(before);
    });

    it("emits eval.outcome.labeled transactionally, exactly one per outcome row", async () => {
        const { rows } = await pool.query(
            `SELECT payload FROM outbox WHERE event_type = 'eval.outcome.labeled' AND payload->'payload'->>'decisionId' = $1 ORDER BY id`,
            [made.WIPRO.decisionId]
        );
        expect(rows).toHaveLength(2);
        const fiveDay = rows.map((r) => r.payload.payload).find((p) => p.horizon === "5d");
        expect(fiveDay).toMatchObject({ hit: "target", realizedReturnBps: 500, basis: "path", sessionsUsed: 2 });
    });

    it("outcomes are append-only facts", async () => {
        await expect(pool.query("UPDATE outcomes SET hit = 'stop'")).rejects.toThrow(/append-only/);
        await expect(pool.query("DELETE FROM outcomes")).rejects.toThrow(/append-only/);
        await expect(pool.query("TRUNCATE outcomes")).rejects.toThrow(/append-only/);
    });

    it("replay: relabeling math from the stored decision + same candles reproduces the stored outcome", async () => {
        const { labelDecisionOutcome } = await import("@zentrade/domain-evaluation");
        const d = (await pool.query("SELECT action, mode, entry_minor, target_minor, stop_minor, created_at FROM decisions WHERE id = $1", [made.WIPRO.decisionId])).rows[0];
        const replayed = labelDecisionOutcome(
            {
                action: d.action,
                mode: d.mode,
                entryMinor: Number(d.entry_minor),
                targetMinor: Number(d.target_minor),
                stopMinor: Number(d.stop_minor),
                createdAt: new Date(d.created_at).toISOString(),
            },
            { key: "5d", sessions: 5 },
            await providerFor()("WIPRO")
        );
        const stored = (await pool.query("SELECT basis, hit, exit_minor, realized_return_bps FROM outcomes WHERE decision_id = $1 AND horizon = '5d'", [made.WIPRO.decisionId])).rows[0];
        expect(replayed).toMatchObject({ basis: stored.basis, hit: stored.hit, exitMinor: Number(stored.exit_minor), realizedReturnBps: stored.realized_return_bps });
    });
});
