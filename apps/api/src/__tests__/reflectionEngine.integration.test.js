import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Reflection engine integration (M16): real Postgres + real Redis.
 * Append-only house rule: snapshots accumulate, assertions are delta-based.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const HASH_W = "7".repeat(64);

// journalFixture() writes decisions with created_at = NOW(); AS_OF and the
// calibration baseline dates are computed relative to the clock so this
// suite does not rot the next time it runs after a long wall-clock gap.
const isoPlusDays = (days) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
};
const AS_OF = isoPlusDays(2);

const journalFixture = () => ({
    symbol: "WIPRO",
    trigger: "test",
    contextSnapshot: { price: 550, changePercent: 0.1, priceTimestamp: 1783929474262, marketOpen: false, inputsHash: HASH_W },
    evidence: [{ ref: "price:live", kind: "price", sourceRef: "test", content: { price: 550 }, weight: null }],
    runs: ["technical", "sentiment", "risk", "synthesizer"].map((agentName) => ({
        agentName,
        agentVersion: "v4.0.0",
        modelId: "llama-3.3-70b-versatile",
        inputHash: HASH_W,
        output: { signal: "BULLISH", confidence: "MEDIUM", keyPoints: ["k1", "k2"] },
        status: "ok",
        latencyMs: 500,
        promptTokens: 800,
        completionTokens: 100,
        costUsd: 0.0005,
    })),
    decision: {
        action: "BUY",
        mode: "INTRADAY",
        confidence: "MEDIUM",
        entryMinor: 55000,
        targetMinor: 55550,
        stopMinor: 54725,
        rationale: { traderNote: "note", reasoning: ["r1"], consensus: "majority", macroScore: 0 },
        synthesizerVersion: "v4.0.0",
    },
});

describe.skipIf(!TEST_DB || !TEST_REDIS)("reflection engine (integration)", () => {
    let pool, redis, engine;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        redis = (await import("../config/redis.js")).default;
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        const { seedReferenceData } = await import("../services/referenceData.js");
        await seedReferenceData();
        engine = await import("../services/reflectionEngine.js");

        // a contradictory setup: the same WIPRO BUY produced 2 targets AND 2 stops
        const journal = await import("../services/decisionJournal.js");
        for (const hit of ["target", "target", "stop", "stop"]) {
            const { decisionId } = await journal.journalAnalysis(journalFixture());
            await pool.query(
                `INSERT INTO outcomes (decision_id, horizon, basis, hit, entry_minor, exit_minor, realized_return_bps, sessions_used, data_source)
                 VALUES ($1, 'intraday', 'squareoff', $2, 55000, 55550, $3, 1, 'test')`,
                [decisionId, hit, hit === "target" ? 100 : -50]
            );
        }
        const indexer = await import("../services/memoryIndexer.js");
        await indexer.formEpisodes();

        // calibration history: a backdated baseline first, then the current view
        const calibration = await import("../services/calibrationEngine.js");
        await calibration.computeCalibrationSnapshot({ asOf: isoPlusDays(-9) });
        await calibration.computeCalibrationSnapshot({ asOf: isoPlusDays(1) });
    }, 60_000);

    afterAll(async () => {
        await pool.end();
        redis.disconnect();
    });

    it("appends a reflection snapshot with findings and exactly one event", async () => {
        const snapsBefore = (await pool.query("SELECT COUNT(*)::int AS n FROM reflection_snapshots")).rows[0].n;
        const eventsBefore = (await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE event_type = 'eval.reflection.computed'")).rows[0].n;

        const result = await engine.computeReflectionSnapshot({ asOf: AS_OF });
        expect(result.findingCount).toBeGreaterThanOrEqual(1);

        const snapsAfter = (await pool.query("SELECT COUNT(*)::int AS n FROM reflection_snapshots")).rows[0].n;
        const eventsAfter = (await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE event_type = 'eval.reflection.computed'")).rows[0].n;
        expect(snapsAfter - snapsBefore).toBe(1);
        expect(eventsAfter - eventsBefore).toBe(1);

        const { rows } = await pool.query(
            "SELECT * FROM reflection_findings WHERE snapshot_id = $1 AND kind = 'contradiction'",
            [result.snapshotId]
        );
        expect(rows.length).toBeGreaterThanOrEqual(1);
        const wipro = rows.find((r) => r.subject.startsWith("WIPRO BUY"));
        expect(wipro).toBeDefined();
        expect(wipro.detail.targets).toBeGreaterThanOrEqual(2);
        expect(wipro.detail.stops).toBeGreaterThanOrEqual(2);
        expect(wipro.severity).toBe("warning");
    });

    it("replays: same asOf against the same tables yields identical findings", async () => {
        const a = await engine.computeReflectionSnapshot({ asOf: AS_OF });
        const b = await engine.computeReflectionSnapshot({ asOf: AS_OF });
        const fetch = (id) =>
            pool.query("SELECT kind, severity, subject, detail FROM reflection_findings WHERE snapshot_id = $1 ORDER BY kind, subject", [id]);
        expect((await fetch(b.snapshotId)).rows).toEqual((await fetch(a.snapshotId)).rows);
        expect(b.snapshotId).not.toBe(a.snapshotId); // history appends, never rewrites
    });

    it("facts only: the database rejects unknown kinds and severities", async () => {
        const { rows: [snap] } = await pool.query("SELECT id FROM reflection_snapshots LIMIT 1");
        await expect(
            pool.query(
                `INSERT INTO reflection_findings (snapshot_id, kind, severity, subject, detail)
                 VALUES ($1, 'recommendation', 'warning', 'x', '{}')`,
                [snap.id]
            )
        ).rejects.toThrow(/check/i);
        await expect(
            pool.query(
                `INSERT INTO reflection_findings (snapshot_id, kind, severity, subject, detail)
                 VALUES ($1, 'contradiction', 'urgent', 'x', '{}')`,
                [snap.id]
            )
        ).rejects.toThrow(/check/i);
    });

    it("reflections are append-only", async () => {
        await expect(pool.query("UPDATE reflection_snapshots SET as_of = '1999-01-01'")).rejects.toThrow(/append-only/);
        await expect(pool.query("UPDATE reflection_findings SET severity = 'info'")).rejects.toThrow(/append-only/);
        await expect(pool.query("DELETE FROM reflection_findings")).rejects.toThrow(/append-only/);
        await expect(pool.query("TRUNCATE reflection_snapshots CASCADE")).rejects.toThrow(/append-only/);
    });

    it("latestReflection projects the newest snapshot verbatim", async () => {
        const { snapshotId, findingCount } = await engine.computeReflectionSnapshot({ asOf: AS_OF });
        const { snapshot, findings } = await engine.latestReflection();
        expect(snapshot.id).toBe(snapshotId);
        expect(snapshot.semantics).toBe("reflection_v1");
        expect(findings.length).toBe(findingCount);
        expect(snapshot.finding_count).toBe(findingCount);
    });

    it("nothing on the decision path reads reflection tables", async () => {
        const { execSync } = await import("node:child_process");
        const hits = execSync(
            "grep -rl 'reflection_' src/services/aiEngine.js src/services/decisionJournal.js src/routes/ai.js 2>/dev/null || true",
            { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8" }
        ).trim();
        expect(hits).toBe("");
    });
});
