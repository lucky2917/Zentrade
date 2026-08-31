import "dotenv/config";
import { Sentry, sentryEnabled } from "./config/instrument.js";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import jwt from "jsonwebtoken";
import { pool, initDB } from "./config/db.js";
import redis from "./config/redis.js";
import logger from "./utils/logger.js";
import { clientIp, clientIpKey } from "./utils/clientIp.js";
import { swaggerSpec } from "./config/swagger.js";
import authRoutes from "./routes/auth.js";
import stockRoutes from "./routes/stocks.js";
import tradeRoutes from "./routes/trade.js";
import portfolioRoutes from "./routes/portfolio.js";
import orderRoutes from "./routes/orders.js";
import chartRoutes from "./routes/chart.js";
import indicesRoutes from "./routes/indices.js";
import marketRoutes from "./routes/market.js";
import watchlistRoutes from "./routes/watchlist.js";
import aiRoutes from "./routes/ai.js";
import startMarketWorker, { stopMarketWorker } from "./services/marketWorker.js";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setFeedTracker } from "./services/fyers/feedStatus.js";
import startWebSocketBroadcaster from "./services/websocket.js";
import { narrator, NARRATION_CHANNEL, RUNTIME_HEALTH_KEY }
    from "./services/cockpit/narrator.js";
import { attachCockpit } from "./services/cockpit/transport.js";
import { buildCockpitRouter } from "./routes/cockpit.js";
import { startSquareOffJob, stopSquareOffJob, reconcileSquareOff } from "./services/squareOff.js";
import { initFyersAuth, isConfigured as isFyersConfigured } from "./services/fyers/fyersAuth.js";
import { connect as connectFyersWebSocket, subscribe as subscribeFyersWebSocket, stop as stopFyersWebSocket, setBarSink, setConnectionSink } from "./services/fyers/fyersWebSocket.js";
import { startWatchdog } from "./services/fyers/authWatchdog.js";
import { Bootstrap, buildHealth } from "./services/orchestrator/bootstrap.js";
import { ConnectionTracker, CONNECTION } from "./services/orchestrator/connectionState.js";
import { sessionStateAt } from "./services/orchestrator/session.js";
import { buildOperatorReport, renderOperatorReport } from "./services/orchestrator/operatorReport.js";
import { NewsStore } from "./services/news/ingest.js";
import { makeAnnouncementPoller } from "./services/news/nseAnnouncements.js";
import { BarAggregator } from "./services/fyers/barAggregator.js";
import { makeCandidateAnalyser, makeReassessmentModel } from "./services/autonomous/reasoning.js";
import { startAllLanes, stopAllLanes } from "./services/fyers/laneManager.js";
import { startPreMarketScanner } from "./services/fyers/preMarketScanner.js";
import { startSymbolManager } from "./services/fyers/symbolManager.js";
import fyersRoutes from "./routes/fyers.js";
import { STOCKS } from "./config/stocks.js";
import auth from "./middleware/auth.js";
import { startEventBackbone, stopEventBackbone, getBackboneLag } from "./services/eventBackbone.js";
import { seedReferenceData } from "./services/referenceData.js";
import { startOutcomeLabeler, stopOutcomeLabeler } from "./services/outcomeLabeler.js";
import { startCalibrationEngine, stopCalibrationEngine } from "./services/calibrationEngine.js";
import { startMemoryIndexer, stopMemoryIndexer } from "./services/memoryIndexer.js";
import { startReflectionEngine, stopReflectionEngine } from "./services/reflectionEngine.js";
import { startRegimeLabeler, stopRegimeLabeler } from "./services/regimeLabeler.js";
import instrumentRoutes from "./routes/instruments.js";
import decisionRoutes from "./routes/decisions.js";
import calibrationRoutes from "./routes/calibration.js";
import memoryRoutes from "./routes/memories.js";
import reflectionRoutes from "./routes/reflections.js";
import knowledgeRoutes from "./routes/knowledge.js";
import usMarketRoutes from "./routes/usMarket.js";
import { runWithCorrelation, ensureCorrelationId, metrics } from "@zentrade/observability";
import { startOpsAlarms, stopOpsAlarms } from "./services/opsAlarms.js";

const app = express();

// L1: origins driven by env — localhost only included in dev
const isProd = process.env.NODE_ENV === "production";

// req.ip is only used for logging — rate limiters key on the leftmost XFF
// entry via clientIpKey (see utils/clientIp.js for why hop counting fails
// here: Vercel-proxied and direct requests arrive with different depths).
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS) || (isProd ? 2 : 1);
app.set("trust proxy", trustProxyHops);

const server = createServer(app);

// M6: every request runs inside a correlation scope. The id is honored from
// X-Correlation-Id when it is a well-formed uuid (else minted), echoed back
// on the response, and attached to every log line and enqueued event.
app.use((req, res, next) => {
    const correlationId = ensureCorrelationId(req.headers["x-correlation-id"]);
    res.setHeader("X-Correlation-Id", correlationId);
    metrics.counter("http.requests").inc();
    res.on("finish", () => {
        if (res.statusCode >= 500) metrics.counter("http.responses_5xx").inc();
    });
    runWithCorrelation(correlationId, next);
});
const allowedOrigins = [
    process.env.FRONTEND_URL,
    ...(!isProd ? ["http://localhost:5173", "http://localhost:3000"] : []),
].filter(Boolean);

const io = new Server(server, {
    cors: {
        origin: allowedOrigins,
        methods: ["GET", "POST"],
        credentials: true,
    },
});

// H5: reject unauthenticated socket connections
io.use((socket, next) => {
    const rawCookie = socket.handshake.headers.cookie || "";
    const match = rawCookie.match(/(?:^|;\s*)token=([^;]+)/);
    const token = match ? decodeURIComponent(match[1]) : null;
    if (!token) return next(new Error("Unauthorized"));
    try {
        jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        next(new Error("Unauthorized"));
    }
});

app.use(helmet({ contentSecurityPolicy: isProd ? undefined : false }));
app.use(cors({
    origin: allowedOrigins,
    credentials: true,
}));
app.use(cookieParser());
// Knowledge ingestion carries document bodies far larger than product routes;
// its own parser runs first so the domain size guard (not this ceiling) is the
// authoritative limit. All other routes keep the tight 10kb default.
app.use("/api/knowledge", express.json({ limit: "4mb" }));
app.use(express.json({ limit: "10kb" }));

// One-time IP resolution log — rateLimitClientIp is what the limiters key
// on and should be the real client IP; req.ip is informational only.
// Requires an XFF header so a local port probe can't burn the sample.
let loggedIpSample = false;
app.use((req, res, next) => {
    if (!loggedIpSample && req.headers["x-forwarded-for"] && req.path !== "/api/health" && req.path !== "/api/ready") {
        loggedIpSample = true;
        logger.info("Server", "First request IP resolution sample", {
            trustProxyHops,
            rateLimitClientIp: clientIp(req),
            resolvedIp: req.ip,
            xForwardedFor: req.headers["x-forwarded-for"] || null,
        });
    }
    next();
});

// Liveness/readiness sit above the rate limiter so platform health checks
// can never be throttled into a false "down"
app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
});

app.get("/api/ready", async (req, res) => {
    const checks = { database: false, redis: false };
    try {
        await pool.query("SELECT 1");
        checks.database = true;
    } catch { /* stays false */ }
    try {
        await redis.ping();
        checks.redis = true;
    } catch { /* stays false */ }

    const ready = checks.database && checks.redis;
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "degraded", checks });
});

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIpKey,
});
app.use("/api", apiLimiter);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: clientIpKey,
    message: { error: "Too many attempts, please try again later" },
});
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);

// Brute-force guard that a forged XFF cannot dodge: login attempts are also
// capped per target account. Successful logins don't count against it.
const loginEmailLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => {
        const email = String(req.body?.email ?? "").trim().toLowerCase();
        return email ? `email:${email}` : clientIpKey(req);
    },
    message: { error: "Too many attempts for this account, please try again later" },
});
app.use("/api/auth/login", loginEmailLimiter);

// H4: separate limiter for token refresh — higher ceiling, not auth-critical
const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIpKey,
    message: { error: "Too many refresh attempts" },
});
app.use("/api/auth/refresh", refreshLimiter);

const fyersLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIpKey,
});
app.use("/fyers", fyersLimiter);

const tradeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: clientIpKey,
    message: { error: "Too many trade requests, slow down" },
});
app.use("/api/trade", tradeLimiter);

if (!isProd) {
    app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
        customSiteTitle: "Zentrade API Docs",
        swaggerOptions: { persistAuthorization: true },
    }));
}

app.use("/api/auth", authRoutes);
app.use("/api/stocks", stockRoutes);
app.use("/api/trade", tradeRoutes);
app.use("/api/portfolio", portfolioRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/chart", chartRoutes);
app.use("/api/indices", indicesRoutes);
app.use("/api/market", marketRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/instruments", instrumentRoutes);
app.use("/api/decisions", decisionRoutes);
app.use("/api/calibration", calibrationRoutes);
app.use("/api/memories", memoryRoutes);
app.use("/api/reflections", reflectionRoutes);
app.use("/api/us-market", usMarketRoutes);
app.use("/api/knowledge", knowledgeRoutes);
app.use("/fyers", fyersRoutes);

// M6: process metrics — counters/gauges snapshot for ops
app.get("/internal/metrics", auth, (req, res) => {
    res.json({
        uptimeSecs: Math.round(process.uptime()),
        rssBytes: process.memoryUsage.rss(),
        ...metrics.snapshot(),
    });
});

// M4: event backbone ops view — outbox depth, stream lag, DLQ size
app.get("/internal/eventbus/lag", auth, async (req, res) => {
    try {
        res.json(await getBackboneLag());
    } catch (err) {
        logger.error("EventBackbone", "lag endpoint failed", { error: err.message });
        res.status(500).json({ error: "lag unavailable" });
    }
});

// The operator surface for the autonomous brain. Read-only, authenticated,
// and safe to call at any time. buildHealth and buildOperatorReport already
// existed; without a route they were unreachable from outside the process.
app.get("/internal/brain", auth, async (req, res) => {
    try {
        res.json(await operatorReport());
    } catch (err) {
        logger.error("Operator", "report failed", { error: err.message });
        res.status(500).json({ error: "report unavailable" });
    }
});

app.get("/internal/brain/text", auth, async (req, res) => {
    try {
        res.type("text/plain").send(renderOperatorReport(await operatorReport()));
    } catch (err) {
        logger.error("Operator", "report failed", { error: err.message });
        res.status(500).type("text/plain").send("report unavailable");
    }
});

app.get("/internal/brain/health", auth, (req, res) => res.json(health()));

// The trader cockpit. Read only: this router defines no mutating verb, and
// nothing under it can reach execution, risk or thesis state.
// Both accessors are lazy. Passing `health` by value here evaluates it during
// module initialisation, before its own declaration, and the process dies on a
// temporal dead zone error before it ever listens.
// Every accessor here is lazy. Passing `health` or the account id by value
// evaluates them during module initialisation, before their own declarations,
// and the process dies on a temporal dead zone error before it ever listens.
app.use("/internal/cockpit", buildCockpitRouter({
    // The runtime is in the agent process; its health arrives over Redis.
    runtimeHealth: () => readRuntimeHealth(),
    health: () => health(),
    userId: () => DEFAULT_USER_ID,
}));

// Emergency stop. HALTED keeps monitoring and reconciliation running while
// refusing every action that adds or changes exposure, which is safer than
// killing the process and losing in-flight reconciliation.
app.post("/internal/brain/halt", auth, express.json(), (req, res) => {
    if (!orchestrator) return res.status(409).json({ error: "autonomous runtime is not running" });
    const halted = req.body?.halted !== false;
    orchestrator.orchestrator.setHalted(halted, req.body?.reason ?? "operator request");
    logger.warn("Operator", `brain halted=${halted}`, { reason: req.body?.reason ?? null });
    res.json({ halted, session: orchestrator.orchestrator.session() });
});

// Unknown API routes get JSON, not Express's HTML 404 page
app.use("/api", (req, res) => {
    res.status(404).json({ error: "Not found" });
});

// Sentry captures the error, then passes it on to the JSON handler below
if (sentryEnabled) {
    Sentry.setupExpressErrorHandler(app);
}

// Central error handler: malformed JSON bodies and anything thrown by
// middleware become clean JSON instead of an HTML stack page
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (err.type === "entity.parse.failed" || err instanceof SyntaxError) {
        return res.status(400).json({ error: "Invalid JSON body" });
    }
    if (err.type === "entity.too.large") {
        return res.status(413).json({ error: "Request body too large" });
    }
    logger.error("Server", "Unhandled request error", { error: err.message, path: req.path });
    res.status(500).json({ error: "Server error" });
});

const PORT = process.env.PORT || 5000;

const validateEnv = () => {
    const missing = ["JWT_SECRET", "DATABASE_URL", "REDIS_URL"].filter((k) => !process.env[k]);
    if (missing.length > 0) {
        logger.error("Server", `Missing required environment variables: ${missing.join(", ")} — exiting`);
        process.exit(1);
    }
    if (process.env.JWT_SECRET.length < 32) {
        logger.error("Server", "JWT_SECRET must be at least 32 characters — exiting");
        process.exit(1);
    }
    if (isProd && !process.env.FRONTEND_URL) {
        logger.error("Server", "FRONTEND_URL is required in production (CORS origin) — exiting");
        process.exit(1);
    }
};

export const connectionTracker = new ConnectionTracker({ logger });
export let bootstrap = null;
// Kept null in this process by design. The autonomous runtime runs in
// src/agent.js; buildHealth still accepts it so the shape of health does not
// change, and a non-null value here would mean a second runtime exists.
export let orchestrator = null;

// Recovery and reconciliation are per-account. The product is single-account
// today; this makes that assumption explicit rather than implicit.
const DEFAULT_USER_ID = Number(process.env.ZENTRADE_ACCOUNT_ID ?? 1);

export const newsStore = new NewsStore();

// Builds 1m/5m/15m bars from the ticks the websocket already receives. Without
// this the entire intelligence layer is starved: it reads bars:1m:SYMBOL and
// nothing was writing them.
export const barAggregator = new BarAggregator({ redis, logger });

// The trader's own heartbeat, written by the agent process. An expired key
// means the trader is not running, which is a different thing from a trader
// with nothing to say.
export const readRuntimeHealth = async () => {
    try {
        const raw = await redis.get(RUNTIME_HEALTH_KEY);
        if (!raw) return { running: false, reason: "the agent is not running" };
        return { running: true, ...JSON.parse(raw) };
    } catch (err) {
        return { running: false, reason: err.message };
    }
};

export const health = () => buildHealth({
    bootstrap, orchestrator, connection: connectionTracker,
});

// The operator view: one structured answer to "is the brain alive and what is
// it doing". Reads state, changes nothing.
export const operatorReport = async () => buildOperatorReport({
    runtime: orchestrator, bootstrap, connection: connectionTracker, newsStore,
    engine: await import("./services/execution/engine.js"),
    userId: DEFAULT_USER_ID,
});

const start = async () => {
    validateEnv();

    await redis.ping();
    logger.info("Server", "Redis connection verified");

    await initDB();

    // M5: instrument registry + calendar exceptions (idempotent, transactional)
    await seedReferenceData();

    // One tracker answers "is the feed delivering" for the pollers too, so REST
    // stands down while the websocket is healthy instead of racing it.
    setFeedTracker(connectionTracker);
    startMarketWorker();
    startWebSocketBroadcaster(io);
    // Narration rides the socket that already exists rather than a second one.
    attachCockpit(io, narrator);
    startSquareOffJob();
    startEventBackbone();
    startRegimeLabeler();
    startOutcomeLabeler();
        startCalibrationEngine();
        startMemoryIndexer();
        startReflectionEngine();
    startOpsAlarms();

    // C3: catch positions missed while Render instance was sleeping
    await reconcileSquareOff();

    server.listen(PORT, () => {
        logger.info("Server", `Zentrade server running on port ${PORT}`);
    });

    // Ordered boot. A critical stage failing stops the sequence; an optional
    // one leaves the process alive but unable to add exposure.
    bootstrap = new Bootstrap({
        logger,
        steps: {
            config: async () => true,          // validateEnv already ran above
            database: async () => { await pool.query("SELECT 1"); return true; },
            redis: async () => { await redis.ping(); return true; },
            recovery: async () => {
                const { openOrders } = await import("./services/execution/engine.js");
                const open = await openOrders(DEFAULT_USER_ID);
                logger.info("Server", `recovered ${open.length} open order(s)`);
                return { openOrders: open.length };
            },
            reconciliation: async () => {
                const { hasUnresolvedAmbiguity } = await import("./services/execution/reconcile.js");
                const ambiguous = await hasUnresolvedAmbiguity(DEFAULT_USER_ID);
                if (ambiguous) {
                    logger.error("Server",
                        "unresolved AMBIGUOUS order(s): new exposure stays blocked until reconciled");
                }
                return { ambiguous };
            },
            session: async () => sessionStateAt(new Date()),
            "fyers-auth": async () => {
                if (!isFyersConfigured()) throw new Error("Fyers not configured");

                // Acquire the token BEFORE initFyersAuth, so the SDK is handed
                // a live one rather than starting blind and being fixed later.
                //
                // When this deployment does not own the OAuth callback the
                // token lives in the deployment that does; this fetches it from
                // the configured source. That is why there is no separate sync
                // command to remember.
                const { ensureFyersToken, acquired } =
                    await import("./services/fyers/tokenSource.js");
                const { fyers } = await import("./services/fyers/fyersAuth.js");
                // Verified with Fyers here, so a token that will be refused at
                // socket connect fails THIS stage, which names it, rather than
                // surfacing three stages later as an opaque JWT decode error.
                const { status, message } = await ensureFyersToken({
                    redis, logger, verify: true, fyers });
                logger.info("Server", `Fyers token: ${message}`, { status });

                await initFyersAuth();
                startWatchdog();

                // Configured but unauthenticated is not a usable state: the
                // socket cannot open and the runtime would observe nothing.
                // Fail the stage so boot reports it instead of running blind.
                if (!acquired(status)) throw new Error(`no Fyers access token — ${message}`);
                return true;
            },
            "market-data": async () => {
                // The socket reports its own state. Claiming CONNECTED here
                // would mark the feed healthy before it opened, and would stay
                // healthy after it died.
                setBarSink(barAggregator);
                setConnectionSink(connectionTracker);
                connectionTracker.onConnecting();
                await connectFyersWebSocket();
                subscribeFyersWebSocket(STOCKS.map((s) => s.symbol));
                return { subscribed: STOCKS.length };
            },
            symbols: async () => { await startSymbolManager(); return true; },
            orchestrator: async () => {
                startAllLanes();
                startPreMarketScanner();

                // The autonomous runtime lives in its OWN process (src/agent.js,
                // started by `npm run agent`). This process owns the Fyers
                // vendor edge, the API, the socket and the cockpit; it must not
                // be able to start a second runtime, because two orchestrators
                // over one account is two of every decision.
                //
                // Narration from the agent is relayed to the cockpit here.
                await narrator.consumeFrom(redis, NARRATION_CHANNEL);
                logger.info("Server", "following the trader's narration",
                            { channel: NARRATION_CHANNEL });
                return { autonomous: false, runsIn: "npm run agent" };
            },
        },
    });

    mountCockpitUI();

    const boot = await bootstrap.run();
    if (!boot.ok) {
        logger.error("Server", `boot failed at ${boot.stage}: ${boot.error}`);
    }
    logger.info("Server", `health: ${health().status}`);
    await printBanner();
};

// The cockpit is served by the API when a web build exists, so watching the
// autonomous trader is one command and one port rather than two processes and
// a proxy. Mounted last, so it can never shadow an API route, and it serves
// static assets only — there is no server-rendered path from here to anything
// that acts.
const mountCockpitUI = () => {
    const dist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
    if (!existsSync(join(dist, "index.html"))) {
        logger.info("Server",
            "web build not found; the cockpit is served by the dev server instead",
            { expected: "apps/web/dist" });
        return;
    }
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    // The cockpit is a single-page route; a refresh on it must return the app
    // shell rather than a 404.
    for (const route of ["/trader", "/architecture-progress"]) {
        app.get(route, (req, res) => res.sendFile(join(dist, "index.html")));
    }
    logger.info("Server", "cockpit UI mounted", { route: "/trader" });
};

// The feed is only "trusted" once ticks have actually arrived, so outside
// market hours it is correctly connected and correctly untrusted. Saying that
// plainly stops a closed market from reading as a broken one.
const marketClosed = (snapshot) =>
    snapshot.session === "CLOSED" || snapshot.session === "PRE_MARKET";

const feedLine = (snapshot) => {
    const state = snapshot.connection?.state ?? "UNKNOWN";
    if (snapshot.connection?.trusted) return `${state} (ticks flowing)`;
    if (marketClosed(snapshot)) return `${state} (no ticks — market ${snapshot.session})`;
    return `${state} (not trusted — no recent ticks)`;
};

// The autonomous runtime lives in the agent process and reports its own
// heartbeat. This process can only say whether it has seen one.
const traderLine = (snapshot) => (snapshot.traderRunning
    ? `RUNNING (fast plane ${snapshot.traderPlane ?? "unknown"})`
    : "not started — run `npm run agent` in another terminal");

const healthLine = (snapshot) => {
    const status = snapshot.status ?? "UNKNOWN";
    if (status !== "READY" && marketClosed(snapshot)) {
        return `${status} (expected — the market is ${snapshot.session})`;
    }
    return status;
};

// One place that answers "is it up, and where do I watch it" without reading
// ten log lines. Everything printed is read from real state.
const printBanner = async () => {
    const runtime = await readRuntimeHealth();
    const snapshot = {
        ...health(),
        traderRunning: Boolean(runtime?.running),
        traderPlane: runtime?.fastPlane?.mode ?? null,
    };
    // Prefer the port this process is actually serving on: with the web build
    // mounted, that is where the cockpit lives.
    const dist = join(dirname(fileURLToPath(import.meta.url)), "../../web/dist");
    // Always the local cockpit: FRONTEND_URL is the deployed frontend, which
    // talks to the deployed backend rather than this process.
    const cockpitUrl = existsSync(join(dist, "index.html"))
        ? `http://localhost:${PORT}/trader`
        : "http://localhost:5173/trader";
    const line = (label, value) => `  ${label.padEnd(16)}${value}`;
    process.stdout.write([
        "",
        "  ZEN TRADE AI TRADER",
        "  -------------------",
        line("MODE", "PAPER"),
        // The fast plane and the brain belong to the agent process. Reporting
        // them here as OFF or DISABLED described this process's own state as
        // though it were the system's, which reads as a broken stack when the
        // agent simply has not been started yet.
        line("ROLE", "API · Fyers edge · cockpit"),
        line("TRADER", traderLine(snapshot)),
        line("MARKET", snapshot.session ?? "UNKNOWN"),
        line("FEED", feedLine(snapshot)),
        line("HEALTH", healthLine(snapshot)),
        line("COCKPIT", cockpitUrl),
        line("HALT", `POST ${`http://localhost:${PORT}`}/internal/brain/halt`),
        "",
    ].join("\n"));
};

start();

let shuttingDown = false;
const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Server", `${signal} received, shutting down gracefully`);

    io.close(() => logger.info("Server", "Socket.io closed"));
    server.close(() => logger.info("Server", "HTTP server closed"));

    try {
        // X3: stop cron tasks so no new work fires during drain
        stopSquareOffJob();
        stopRegimeLabeler();
        stopReflectionEngine();
    stopMemoryIndexer();
    stopCalibrationEngine();
    stopOutcomeLabeler();
        stopOpsAlarms();
        await stopEventBackbone();
        await barAggregator.flush();
        stopAllLanes();
        stopMarketWorker();
        stopFyersWebSocket();
        connectionTracker.onDisconnected("shutdown");
        await pool.end();
        await redis.quit();
    } catch (err) {
        logger.error("Server", "Error during shutdown", { error: err.message });
    }

    setTimeout(() => process.exit(0), 2000).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
    logger.error("Server", "Uncaught exception", { error: err.message, stack: err.stack });
    process.exit(1);
});

process.on("unhandledRejection", (reason) => {
    logger.error("Server", "Unhandled rejection", { reason: reason?.message || reason });
});
