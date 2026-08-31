import "dotenv/config";
import { pool } from "./config/db.js";
import redis from "./config/redis.js";
import logger from "./utils/logger.js";
import { STOCKS } from "./config/stocks.js";
import { NewsStore } from "./services/news/ingest.js";
import { ConnectionTracker } from "./services/orchestrator/connectionState.js";
import { narrator, NARRATION_CHANNEL, RUNTIME_HEALTH_KEY, RUNTIME_HEALTH_TTL_SECONDS }
    from "./services/cockpit/narrator.js";

// The autonomous trader, as its own process.
//
// It runs the orchestrator, the Senior Trader Brain, the risk gate and paper
// execution. It does NOT serve HTTP and it does NOT own the Fyers socket: the
// API process owns the vendor edge and publishes ticks, and the Go fast plane
// owns continuous detection.
//
// Splitting it out is what makes the brain restartable without dropping the
// market feed or the cockpit, and it is why there is exactly one runtime: the
// API cannot start a second one.
//
// PAPER ONLY. No order-placement code exists anywhere in this repository.

const USER_ID = Number(process.env.ZENTRADE_ACCOUNT_ID ?? 1);
const PRICE_CHANNEL = "price:update";
const HEALTH_INTERVAL_MS = 5_000;

const banner = (runtime, plane, cockpitUrl) => {
    const health = runtime.health();
    const line = (label, value) => `  ${label.padEnd(18)}${value}`;
    const url = cockpitUrl;
    process.stdout.write([
        "",
        "  ZEN TRADE AUTONOMOUS TRADER",
        "  ===========================",
        "",
        line("MODE", health.mode),
        line("FAST PLANE", plane === "off" ? "OFF (local reflex protecting)"
                                           : `ACTIVE (${plane})`),
        line("SENIOR BRAIN", "ACTIVE"),
        line("RISK", health.orchestrator.halted ? "HALTED" : "ARMED"),
        line("EXECUTION", "PAPER"),
        line("MARKET", health.orchestrator.session),
        line("ARMED POSITIONS", String(health.reflex.armedSymbols ?? 0)),
        "",
        "  TRADER IS RUNNING",
        "",
        "  COCKPIT:",
        `  ${url}`,
        "",
    ].join("\n"));
};

const start = async () => {
    await pool.query("SELECT 1");
    await redis.ping();

    const { AutonomousRuntime, MODE } = await import("./services/autonomous/runtime.js");
    const { buildLivePorts } = await import("./services/autonomous/livePorts.js");
    const { makeCandidateAnalyser, makeReassessmentModel } =
        await import("./services/autonomous/reasoning.js");
    const { makeMemoryRetriever } = await import("./services/memory/repository.js");
    const { FastPlaneBridge, modeFromEnv } = await import("./services/tick/fastPlane.js");
    const { makeAnnouncementPoller } = await import("./services/news/nseAnnouncements.js");
    const { BarAggregator } = await import("./services/fyers/barAggregator.js");
    const engine = await import("./services/execution/engine.js");
    const reconciler = await import("./services/execution/reconcile.js");

    // Narration is published for the API process to relay to the cockpit. The
    // runtime assigns the sequence; the reader preserves it.
    narrator.publishTo(redis, NARRATION_CHANNEL);

    const newsStore = new NewsStore();
    const connectionTracker = new ConnectionTracker({ logger });
    const universe = STOCKS.map((s) => s.symbol);
    const planeMode = modeFromEnv(process.env.ZENTRADE_FAST_PLANE);

    const runtime = new AutonomousRuntime({
        engine, reconciler, mode: MODE.PAPER, userId: USER_ID, logger,
        // Bars are built by the API process from the socket it owns; this
        // process reads them. Passing no aggregator is what stops a second
        // one from existing.
        barAggregator: null,
        narrator,
        fastPlane: new FastPlaneBridge({ mode: planeMode, logger }),
        ports: buildLivePorts({
            userId: USER_ID, newsStore, connectionTracker, universe, logger,
            ingestNews: makeAnnouncementPoller({ store: newsStore, logger }),
            callModel: makeReassessmentModel({ logger, narrator }),
            analyseCandidate: makeCandidateAnalyser({ logger, narrator }),
            retrieveMemories: makeMemoryRetriever({ logger }),
        }),
    });

    // The tick stream. The API process owns the vendor socket and publishes
    // every tick here; this process feeds them to the local reflex, which is
    // the protection path when the Go plane is off and the comparison baseline
    // when it is on.
    const ticks = redis.duplicate();
    await ticks.subscribe(PRICE_CHANNEL);
    ticks.on("message", (channel, payload) => {
        if (channel !== PRICE_CHANNEL) return;
        try {
            const tick = JSON.parse(payload);
            connectionTracker.onTick(Date.now());
            runtime.ingestTick(tick);
        } catch (err) {
            logger.error("Agent", "tick could not be ingested", { error: err.message });
        }
    });
    connectionTracker.onConnecting();
    connectionTracker.onConnected();

    // The account is opened (once, ever) and its opening state recorded before
    // the runtime starts. If this process resumed a day that already had cash,
    // positions and P&L, that is what it continues from.
    const { openAccountSession } = await import("./services/account/session.js");
    const accountSession = await openAccountSession({ userId: USER_ID, logger });
    logger.info("Agent", "paper account resumed", {
        sessionDate: accountSession.sessionDate,
        cashPaise: accountSession.opening?.cashPaise ?? null,
        equityPaise: accountSession.opening?.equityPaise ?? null,
        openPositions: accountSession.opening?.positions?.length ?? 0,
    });

    await runtime.start();
    // The cockpit this stack serves is the local one. FRONTEND_URL names the
    // deployed frontend, which talks to the deployed backend — a different
    // system, and the wrong place to look at this trader.
    const { existsSync } = await import("node:fs");
    const { join, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const dist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
    const port = process.env.PORT ?? 5000;
    banner(runtime, planeMode, existsSync(join(dist, "index.html"))
        ? `http://localhost:${port}/trader`
        : "http://localhost:5173/trader");

    // The runtime's own heartbeat, so the cockpit can tell a quiet brain from a
    // dead one. Short TTL: a dead runtime disappears rather than leaving a
    // record that reads as healthy.
    const { buildWorld } = await import("./services/cockpit/state.js");
    const heartbeat = setInterval(async () => {
        try {
            await redis.set(RUNTIME_HEALTH_KEY, JSON.stringify({
                at: new Date().toISOString(), pid: process.pid,
                ...runtime.health(),
                world: buildWorld(runtime),
                planeHealth: await runtime.fastPlane.planeHealth(),
            }), "EX", RUNTIME_HEALTH_TTL_SECONDS);
        } catch (err) {
            logger.warn("Agent", "heartbeat not written", { error: err.message });
        }
    }, HEALTH_INTERVAL_MS);
    heartbeat.unref();

    let stopping = false;
    const shutdown = async (signal) => {
        if (stopping) return;
        stopping = true;
        logger.info("Agent", `${signal} received, stopping the trader`);
        clearInterval(heartbeat);
        try {
            // Order matters: stop taking new work, drain and reconcile, close
            // the day's account record, then let go of the connections that all
            // of that needs.
            await runtime.stop();
            await accountSession.close(signal);
            await redis.del(RUNTIME_HEALTH_KEY);
            await ticks.quit().catch(() => {});
            await pool.end().catch(() => {});
            await redis.quit().catch(() => {});
        } catch (err) {
            logger.error("Agent", "error during shutdown", { error: err.message });
        }
        process.exit(0);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    // A dropped socket is not a reason to stop trading.
    //
    // Postgres and Redis both sit behind TLS connections that idle out, and
    // both pools reconnect on their own. Treating `read ETIMEDOUT` as fatal
    // killed the trader mid-session with an open position — the pools would
    // have recovered in seconds, and the exit lost the whole session instead.
    //
    // Anything NOT in this list is still fatal. A genuine programming fault
    // must not be swallowed and left running in an unknown state.
    const TRANSIENT = new Set([
        "ETIMEDOUT", "ECONNRESET", "EPIPE", "ECONNREFUSED", "ENOTFOUND",
        "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN",
    ]);
    process.on("uncaughtException", (err) => {
        if (TRANSIENT.has(err?.code)) {
            logger.warn("Agent", "transient connection error; the pool will reconnect",
                        { error: err.message, code: err.code });
            return;
        }
        logger.error("Agent", "uncaught exception", { error: err.message, stack: err.stack });
        shutdown("uncaughtException");
    });
    process.on("unhandledRejection", (reason) => {
        logger.error("Agent", "unhandled rejection", { reason: reason?.message ?? reason });
    });
};

start().catch((err) => {
    logger.error("Agent", "the trader could not start", { error: err.message });
    process.stdout.write(`\n  THE TRADER COULD NOT START\n    ${err.message}\n\n`);
    process.exit(1);
});
