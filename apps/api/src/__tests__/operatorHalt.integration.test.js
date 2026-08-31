import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const TEST_DB = process.env.TEST_DATABASE_URL;
const TEST_REDIS = process.env.TEST_REDIS_URL;
if (TEST_REDIS) process.env.REDIS_URL = TEST_REDIS;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

// The emergency stop.
//
// It did not exist. index.js declared `orchestrator` and never assigned it,
// because the only runtime lives in the agent process, so POST /brain/halt
// always answered 409 and there was no way to stop the trader. The intent now
// travels through a durable key that the runtime reads.

describe.skipIf(!TEST_DB || !TEST_REDIS)("the operator can stop the trader", () => {
    let pool, redis, ports, HALT_KEY;
    const USER = 8494;

    beforeAll(async () => {
        ({ pool } = await import("../config/db.js"));
        const { runMigrations } = await import("../config/migrations.js");
        await runMigrations(pool);
        ({ default: redis } = await import("../config/redis.js"));
        ({ RUNTIME_HALT_KEY: HALT_KEY } = await import("../services/cockpit/narrator.js"));
        const { buildLivePorts } = await import("../services/autonomous/livePorts.js");
        ports = buildLivePorts({ userId: USER, newsStore: null, connectionTracker: null });
    });

    beforeEach(async () => { await redis.del(HALT_KEY); });

    afterAll(async () => {
        if (redis) { await redis.del(HALT_KEY); await redis.quit(); }
        if (pool) await pool.end();
    });

    it("reads no halt when none was requested", async () => {
        expect(await ports.readHaltRequest()).toEqual({ halted: false, reason: null });
    });

    it("reads the operator's stop and its reason", async () => {
        await redis.set(HALT_KEY, JSON.stringify({
            halted: true, reason: "feed looks wrong", at: new Date().toISOString() }));
        expect(await ports.readHaltRequest())
            .toEqual({ halted: true, reason: "feed looks wrong" });
    });

    // A halt an agent restart silently undid would be worse than no halt: the
    // operator would believe the system was held while it traded.
    it("survives the agent restarting", async () => {
        await redis.set(HALT_KEY, JSON.stringify({ halted: true, reason: "overnight" }));
        const { buildLivePorts } = await import("../services/autonomous/livePorts.js");
        const afterRestart = buildLivePorts({
            userId: USER, newsStore: null, connectionTracker: null });
        expect((await afterRestart.readHaltRequest()).halted).toBe(true);
    });

    it("treats an unreadable request as unknown rather than as a resume", async () => {
        await redis.set(HALT_KEY, "not json at all");
        expect(await ports.readHaltRequest()).toBeNull();
    });

    describe("applied by the runtime", () => {
        const makeRuntime = async (readHaltRequest) => {
            const { AutonomousRuntime, MODE } = await import("../services/autonomous/runtime.js");
            const engine = await import("../services/execution/engine.js");
            return new AutonomousRuntime({
                engine, reconciler: null, mode: MODE.PAPER, userId: USER,
                ports: {
                    loadPositions: async () => [],
                    loadPortfolio: async () => ({ cashPaise: 0, positions: [] }),
                    readHaltRequest,
                },
            });
        };

        it("halts the orchestrator and says why", async () => {
            const runtime = await makeRuntime(
                async () => ({ halted: true, reason: "operator request" }));
            expect(runtime.orchestrator.halted).toBe(false);

            expect(await runtime.applyHaltRequest()).toEqual({ halted: true, changed: true });
            expect(runtime.orchestrator.halted).toBe(true);
            expect(runtime.orchestrator.session()).toBe("HALTED");
            expect(runtime.metrics.haltChanges).toBe(1);
        });

        it("does not act again once it has applied the stop", async () => {
            const runtime = await makeRuntime(async () => ({ halted: true, reason: "x" }));
            await runtime.applyHaltRequest();
            expect(await runtime.applyHaltRequest()).toEqual({ halted: true, changed: false });
            expect(runtime.metrics.haltChanges).toBe(1);
        });

        it("resumes when the operator clears it", async () => {
            let halted = true;
            const runtime = await makeRuntime(async () => ({ halted, reason: null }));
            await runtime.applyHaltRequest();
            halted = false;
            expect(await runtime.applyHaltRequest()).toEqual({ halted: false, changed: true });
            expect(runtime.orchestrator.halted).toBe(false);
        });

        it("stays halted when the request cannot be read", async () => {
            let request = { halted: true, reason: "operator request" };
            const runtime = await makeRuntime(async () => request);
            await runtime.applyHaltRequest();

            request = null;   // Redis unreachable
            const result = await runtime.applyHaltRequest();
            expect(result).toEqual({ halted: true, changed: false, unreadable: true });
            expect(runtime.orchestrator.halted).toBe(true);
        });

        it("registers no watch when the ports cannot read one", async () => {
            const runtime = await makeRuntime(undefined);
            const names = runtime.orchestrator.scheduler.health().jobs.map((j) => j.name);
            expect(names).not.toContain("halt-watch");
        });
    });
});
