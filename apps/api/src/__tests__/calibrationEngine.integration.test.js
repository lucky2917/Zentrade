import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * Calibration engine integration (M13): real Postgres + real Redis.
 * Append-only house rule applies: snapshots accumulate across runs, so
 * every assertion is delta-based or shape-based, never absolute.
 */
const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;

if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const HASH_C = "c".repeat(64);

const journalFixture = () => ({
    symbol: "RELIANCE",
    trigger: "test",
    contextSnapshot: { price: 1500, changePercent: 0.5, priceTimestamp: 1783929474262, marketOpen: false, inputsHash: HASH_C },
    evidence: [{ ref: "price:live", kind: "price", sourceRef: "test", content: { price: 1500 }, weight: null }],
    runs: ["technical", "sentiment", "risk", "synthesizer"].map((agentName) => ({
        agentName,
        agentVersion: "v4.0.0",
        modelId: "llama-3.3-70b-versatile",
        inputHash: HASH_C,
        output: { signal: "BULLISH", confidence: "MEDIUM", keyPoints: ["p1", "p2"] },
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
        entryMinor: 150000,
        targetMinor: 151500,
        stopMinor: 149250,
        rationale: { traderNote: "note", reasoning: ["r1"], consensus: "majority", macroScore: 0 },
        synthesizerVersion: "v4.0.0",
    },
});

describe.skipIf(!TEST_DB || !TEST_REDIS)("calibration engine (integration)", () => {
    let pool, redis, engine, journal;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        redis = (await import("../config/redis.js")).default;
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        const { seedReferenceData } = await import("../services/referenceData.js");
        await seedReferenceData();
        engine = await import("../services/calibrationEngine.js");
        journal = await import("../services/decisionJournal.js");

        // seed 12 decided-and-labeled analyses so at least one cell clears the gate
        for (let i = 0; i < 12; i++) {
            const { decisionId } = await journal.journalAnalysis(journalFixture());
            await pool.query(
                `INSERT INTO outcomes (decision_id, horizon, basis, hit, entry_minor, exit_minor, realized_return_bps, sessions_used, data_source)
                 VALUES ($1, 'intraday', 'squareoff', 'target', 150000, 151500, 100, 1, 'test')`,
                [decisionId]
            );
        }
    }, 60_000);

    afterAll(async () => {
        await pool.end();
        redis.disconnect();
    });

    it("computes an append-only snapshot with cells and exactly one event", async () => {
        const snapshotsBefore = (await pool.query("SELECT COUNT(*)::int AS n FROM calibration_snapshots")).rows[0].n;
        const eventsBefore = (await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE event_type = 'eval.calibration.updated'")).rows[0].n;

        const result = await engine.computeCalibrationSnapshot();
        expect(result.sampleCount).toBeGreaterThanOrEqual(48); // 12 decisions x 4 scoreable agents
        expect(result.cellCount).toBeGreaterThan(0);

        const snapshotsAfter = (await pool.query("SELECT COUNT(*)::int AS n FROM calibration_snapshots")).rows[0].n;
        const eventsAfter = (await pool.query("SELECT COUNT(*)::int AS n FROM outbox WHERE event_type = 'eval.calibration.updated'")).rows[0].n;
        expect(snapshotsAfter - snapshotsBefore).toBe(1);
        expect(eventsAfter - eventsBefore).toBe(1);

        const { rows: cells } = await pool.query(
            "SELECT * FROM calibration_cells WHERE snapshot_id = $1 AND agent_name = 'synthesizer' AND regime = 'all' AND horizon = 'intraday'",
            [result.snapshotId]
        );
        expect(cells).toHaveLength(1);
        expect(cells[0].n).toBeGreaterThanOrEqual(12);
        expect(cells[0].sufficient).toBe(true);
        expect(Number(cells[0].brier)).toBeGreaterThanOrEqual(0);
        expect(Number(cells[0].brier)).toBeLessThanOrEqual(1);
    });

    it("insufficient cells carry NULL metrics, never a number (DB law included)", async () => {
        const { rows } = await pool.query(
            "SELECT COUNT(*)::int AS bad FROM calibration_cells WHERE NOT sufficient AND (brier IS NOT NULL OR hit_rate IS NOT NULL)"
        );
        expect(rows[0].bad).toBe(0);
        await expect(
            pool.query(
                `INSERT INTO calibration_cells (snapshot_id, agent_name, agent_version, regime, horizon, n, n_effective, sufficient, brier, hit_rate)
                 SELECT id, 'x', 'v1', 'all', 'h', 1, 1, false, 0.5, 0.5 FROM calibration_snapshots LIMIT 1`
            )
        ).rejects.toThrow(/check/i);
    });

    it("stored numbers are independently reproducible from raw outcomes (notebook check)", async () => {
        const asOf = "2026-07-15";
        const { snapshotId } = await engine.computeCalibrationSnapshot({ asOf });
        const samples = await engine.gatherCalibrationSamples(asOf);

        // reproduce the synthesizer/all/intraday cell with plain arithmetic
        const members = samples.filter((s) => s.agentName === "synthesizer" && s.horizon === "intraday");
        const P = { HIGH: 0.75, MEDIUM: 0.55, LOW: 0.35 };
        let sumW = 0, sumW2 = 0, brierAcc = 0, hitAcc = 0;
        for (const m of members) {
            const w = 0.5 ** (m.ageDays / 90);
            sumW += w; sumW2 += w * w;
            brierAcc += w * (P[m.confidence] - (m.success ? 1 : 0)) ** 2;
            hitAcc += w * (m.success ? 1 : 0);
        }
        const { rows: [cell] } = await pool.query(
            "SELECT * FROM calibration_cells WHERE snapshot_id = $1 AND agent_name = 'synthesizer' AND regime = 'all' AND horizon = 'intraday'",
            [snapshotId]
        );
        expect(cell.n).toBe(members.length);
        expect(Number(cell.n_effective)).toBeCloseTo((sumW * sumW) / sumW2, 2);
        expect(Number(cell.brier)).toBeCloseTo(brierAcc / sumW, 5);
        expect(Number(cell.hit_rate)).toBeCloseTo(hitAcc / sumW, 3);
    });

    it("recomputation appends history; it never rewrites a prior snapshot", async () => {
        const a = await engine.computeCalibrationSnapshot({ asOf: "2026-07-15" });
        const b = await engine.computeCalibrationSnapshot({ asOf: "2026-07-15" });
        expect(b.snapshotId).not.toBe(a.snapshotId);
        expect(b.cellCount).toBe(a.cellCount); // same data + same asOf -> same cells, new rows

        await expect(pool.query("UPDATE calibration_snapshots SET as_of = '1999-01-01'")).rejects.toThrow(/append-only/);
        await expect(pool.query("DELETE FROM calibration_cells")).rejects.toThrow(/append-only/);
        await expect(pool.query("TRUNCATE calibration_snapshots CASCADE")).rejects.toThrow(/append-only/);
    });

    it("latestCalibration projects the newest snapshot verbatim", async () => {
        const { snapshotId } = await engine.computeCalibrationSnapshot();
        const { snapshot, cells } = await engine.latestCalibration();
        expect(snapshot.id).toBe(snapshotId);
        expect(snapshot.semantics).toBe("calibration_v1");
        expect(cells.length).toBe(snapshot.cell_count);
        for (const c of cells) {
            if (!c.sufficient) {
                expect(c.brier).toBeNull();
                expect(c.hit_rate).toBeNull();
            }
        }
    });

    it("nothing on the decision path reads calibration tables (measurement, not influence)", async () => {
        const { execSync } = await import("node:child_process");
        const hits = execSync(
            "grep -rl 'calibration_' src/services/aiEngine.js src/services/decisionJournal.js src/routes/ai.js 2>/dev/null || true",
            { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8" }
        ).trim();
        expect(hits).toBe("");
    });
});
