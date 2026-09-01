import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// THE WHOLE PATH.
//
//   tick
//    -> Redis price:update
//    -> Go fast plane (separate OS process, real binary)
//    -> deterministic reflex on a pre-committed level
//    -> zentrade.marketdata.event.v1 over Redis pub/sub
//    -> Node bridge
//    -> runtime.protect()
//    -> Phase 1 execution engine
//    -> position
//    -> cockpit narration
//
// Nothing on that path is mocked. The plane is the real compiled binary in its
// own process, Redis and Postgres are real, and the order that comes out the
// far end is a real row written by the real execution engine.
//
// It is not a live venue and does not claim to be. What it proves is that the
// Go plane is genuinely in the data path rather than a parallel component.

const GO_DIR = join(process.cwd(), "../../go");
const USER = 8711;
const SYMBOL = "RELIANCE";

const buildDaemon = () => {
    const out = join(mkdtempSync(join(tmpdir(), "zt-full-")), "marketdatad");
    execFileSync("go", ["build", "-o", out, "./cmd/marketdatad"], { cwd: GO_DIR });
    return out;
};

const waitFor = async (fn, { timeoutMs = 12_000, label = "condition" } = {}) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await fn();
        if (value) return value;
        await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${label}`);
};

describe.skipIf(!TEST_DB || !TEST_REDIS || !process.env.ZENTRADE_GO_E2E)(
    "the complete tick to position path", () => {
    let pool, redis, engine, reconcile, AutonomousRuntime, FastPlaneBridge, PLANE_MODE;
    let Narrator, KIND, binary;
    let daemon = null;
    let runtime = null;

    const at = (h, m) => Date.UTC(2026, 7, 31, 0, h * 60 + m - 330, 0);

    beforeEach(async () => {
        ({ pool } = await import("../config/db.js"));
        ({ default: redis } = await import("../config/redis.js"));
        engine = await import("../services/execution/engine.js");
        reconcile = await import("../services/execution/reconcile.js");
        ({ AutonomousRuntime } = await import("../services/autonomous/runtime.js"));
        ({ FastPlaneBridge, PLANE_MODE } = await import("../services/tick/fastPlane.js"));
        ({ Narrator, KIND } = await import("../services/cockpit/narrator.js"));
        if (!binary) binary = buildDaemon();

        await pool.query("DELETE FROM position_reassessments WHERE thesis_id IN (SELECT id FROM trade_thesis WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM position_events WHERE user_id=$1", [USER]);
        // Cooldowns are durable now, so a symbol priced by one test would
        // otherwise be skipped by the next.
        await pool.query("DELETE FROM candidate_cooldowns WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM order_fills WHERE order_id IN (SELECT id FROM orders WHERE user_id=$1)", [USER]);
        await pool.query("DELETE FROM orders WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM trade_thesis WHERE user_id=$1", [USER]);
        await pool.query("DELETE FROM portfolio WHERE user_id=$1", [USER]);
        await pool.query(
            `INSERT INTO users (id, email, balance_paise) VALUES ($1,'fullpath@test',900000000)
             ON CONFLICT (id) DO UPDATE SET balance_paise=900000000`, [USER]);
        await redis.del("zentrade:marketdata:owner", "marketdata:commands:state",
                        "marketdata:events", "shadow:marketdata:events",
                        "marketdata:plane:health");
    });

    afterAll(async () => {
        await runtime?.stop().catch(() => {});
        if (daemon && daemon.exitCode === null) {
            daemon.kill("SIGTERM");
            await new Promise((r) => { daemon.on("exit", r); setTimeout(r, 3000); });
        }
        await pool?.end().catch(() => {});
        await redis?.quit().catch(() => {});
    });

    const startPlane = () => {
        daemon = spawn(binary,
            ["-mode", "live", "-sweep", "500ms", "-health", "127.0.0.1:5698"],
            { env: { ...process.env, REDIS_URL: TEST_REDIS },
              stdio: ["ignore", "pipe", "pipe"] });
        daemon.stdout.on("data", () => {});
        daemon.stderr.on("data", () => {});
        return daemon;
    };

    const openPosition = async (quantity, pricePaise) => {
        const { rows } = await pool.query(
            `INSERT INTO trade_thesis
               (user_id, symbol, correlation_id, side, entry_price_paise, quantity,
                rationale, setup_type, invalidation_conditions, supporting_evidence,
                stop_paise, target_paise, horizon, opened_at)
             VALUES ($1,$2,'corr-full','BUY',$3,$4,'full path test','test',
                     '["close below stop"]'::jsonb,'[]'::jsonb,$5,$6,'INTRADAY',NOW())
             RETURNING id`,
            [USER, SYMBOL, pricePaise, quantity,
             Math.round(pricePaise * 0.97), Math.round(pricePaise * 1.05)]);
        await pool.query(
            `INSERT INTO portfolio (user_id, symbol, quantity, avg_price_paise,
                                    order_mode, margin_used_paise)
             VALUES ($1,$2,$3,$4,'INTRADAY',$5)`,
            [USER, SYMBOL, quantity, pricePaise,
             Math.ceil((pricePaise * quantity) / 5)]);
        return rows[0].id;
    };

    const buildRuntime = ({ narrator, mode = PLANE_MODE.LIVE }) => {
        const bridge = new FastPlaneBridge({ mode, client: redis });
        return new AutonomousRuntime({
            engine, reconciler: reconcile, userId: USER, narrator,
            fastPlane: bridge,
            clock: () => new Date(at(12, 0)),
            ports: {
                loadPositions: async () => {
                    const { openPositions } = await import("../services/autonomous/positionState.js");
                    return openPositions(new Date(at(12, 0)), USER);
                },
                positionFor: async (symbol) => {
                    const { openPositions } = await import("../services/autonomous/positionState.js");
                    return (await openPositions(new Date(at(12, 0)), USER))
                        .find((p) => p.symbol === symbol) ?? null;
                },
                recordEvent: async () => ({ id: 1 }),
                journal: async () => null,
            },
        });
    };

    const holding = async () => {
        const { rows } = await pool.query(
            "SELECT quantity FROM portfolio WHERE user_id=$1 AND symbol=$2", [USER, SYMBOL]);
        return rows.length ? Number(rows[0].quantity) : 0;
    };

    // ---- the proof ---------------------------------------------------------

    it("carries a stop breach from the Go plane to a real paper exit", async () => {
        await openPosition(10, 100_000);   // stop at 97000

        const narrator = new Narrator();
        startPlane();
        await waitFor(() => redis.get("zentrade:marketdata:owner"),
                      { label: "the plane to take ownership" });

        runtime = buildRuntime({ narrator });
        await runtime.start();
        // The brain publishes its commitments; the plane applies them.
        await runtime.fastPlane.flush();
        await waitFor(() => redis.hget("marketdata:commands:state", SYMBOL),
                      { label: "the commitment to reach the plane" });
        await new Promise((r) => setTimeout(r, 400));

        expect(await holding()).toBe(10);

        // A tick, on the wire, exactly as the vendor edge publishes it.
        await redis.publish("price:update", JSON.stringify({
            symbol: SYMBOL, price: 960, volume: 500_000,
            timestamp: Date.now(), source: "websocket",
        }));

        // The far end of the path: a real SELL written by the execution engine.
        await waitFor(async () => (await holding()) === 0,
                      { label: "the protective exit to reach the position" });

        const { rows } = await pool.query(
            "SELECT type, quantity, state FROM orders WHERE user_id=$1", [USER]);
        expect(rows).toHaveLength(1);
        expect(rows[0].type).toBe("SELL");
        expect(Number(rows[0].quantity)).toBe(10);
        expect(rows[0].state).toBe("FILLED");

        // And the cockpit saw it, attributed to the plane that detected it.
        const planeEvent = narrator.recent().find(
            (e) => e.kind === KIND.MARKET_EVENT && e.source === "FAST_PLANE");
        expect(planeEvent).toBeDefined();
        expect(planeEvent.symbol).toBe(SYMBOL);
        expect(planeEvent.type).toBe("STOP");
        expect(narrator.recent().some((e) => e.kind === KIND.PROTECTIVE_EVENT)).toBe(true);
        expect(narrator.recent().some((e) => e.kind === KIND.ORDER_STATE_CHANGED)).toBe(true);
        expect(runtime.metrics.planeEvents).toBeGreaterThan(0);
    }, 60_000);

    // Two actors reacting to one crossing is two exits.
    it("has exactly one authoritative detector when the plane is live", async () => {
        await openPosition(10, 100_000);
        const narrator = new Narrator();
        startPlane();
        await waitFor(() => redis.get("zentrade:marketdata:owner"),
                      { label: "ownership" });

        runtime = buildRuntime({ narrator });
        await runtime.start();
        await runtime.fastPlane.flush();
        await new Promise((r) => setTimeout(r, 400));

        // Drive the LOCAL lane directly with the same breaching price. It must
        // record the crossing for comparison and refuse to act on it.
        runtime.ingestTick({ symbol: SYMBOL, price: 960, timestamp: at(12, 0) });
        await new Promise((r) => setTimeout(r, 300));

        expect(runtime.metrics.localCrossingsSuppressed).toBeGreaterThan(0);
        expect(runtime.metrics.protectiveExits).toBe(0);
        expect(await holding()).toBe(10);
    }, 60_000);

    it("publishes a heartbeat the brain can tell death from silence by", async () => {
        startPlane();
        await waitFor(() => redis.get("zentrade:marketdata:owner"), { label: "ownership" });
        runtime = buildRuntime({ narrator: new Narrator() });

        const health = await waitFor(async () => {
            const h = await runtime.fastPlane.planeHealth();
            return h?.alive ? h : null;
        }, { label: "the plane heartbeat" });

        expect(health.alive).toBe(true);
        expect(health.mode).toBe("live");
        expect(health.contract).toBe("zentrade.marketdata.v1");
        expect(health.plane).toHaveProperty("ticksIngested");

        // And when the plane dies, the brain can see that it died.
        daemon.kill("SIGKILL");
        await new Promise((r) => { daemon.on("exit", r); });
        await redis.del("marketdata:plane:health");
        const dead = await runtime.fastPlane.planeHealth();
        expect(dead.alive).toBe(false);
    }, 60_000);
});
