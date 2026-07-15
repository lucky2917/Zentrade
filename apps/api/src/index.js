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
import startMarketWorker from "./services/marketWorker.js";
import startWebSocketBroadcaster from "./services/websocket.js";
import { startSquareOffJob, stopSquareOffJob, reconcileSquareOff } from "./services/squareOff.js";
import { initFyersAuth, isConfigured as isFyersConfigured } from "./services/fyers/fyersAuth.js";
import { connect as connectFyersWebSocket, subscribe as subscribeFyersWebSocket, stop as stopFyersWebSocket } from "./services/fyers/fyersWebSocket.js";
import { startWatchdog } from "./services/fyers/authWatchdog.js";
import { startAllLanes, stopAllLanes } from "./services/fyers/laneManager.js";
import { startPreMarketScanner } from "./services/fyers/preMarketScanner.js";
import { startSymbolManager } from "./services/fyers/symbolManager.js";
import fyersRoutes from "./routes/fyers.js";
import { STOCKS } from "./config/stocks.js";
import auth from "./middleware/auth.js";
import { startEventBackbone, stopEventBackbone, getBackboneLag } from "./services/eventBackbone.js";
import { seedReferenceData } from "./services/referenceData.js";
import instrumentRoutes from "./routes/instruments.js";
import decisionRoutes from "./routes/decisions.js";
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

const start = async () => {
    validateEnv();

    await redis.ping();
    logger.info("Server", "Redis connection verified");

    await initDB();

    // M5: instrument registry + calendar exceptions (idempotent, transactional)
    await seedReferenceData();

    startMarketWorker();
    startWebSocketBroadcaster(io);
    startSquareOffJob();
    startEventBackbone();
    startOpsAlarms();

    // C3: catch positions missed while Render instance was sleeping
    await reconcileSquareOff();

    server.listen(PORT, () => {
        logger.info("Server", `Zentrade server running on port ${PORT}`);
    });

    try {
        await initFyersAuth();
        startWatchdog();
        if (isFyersConfigured()) {
            await connectFyersWebSocket();
            subscribeFyersWebSocket(STOCKS.map((s) => s.symbol));
            await startSymbolManager();
            startAllLanes();
            startPreMarketScanner();
        } else {
            logger.info("Server", "Fyers not configured, fast-lane websocket disabled");
        }
    } catch (err) {
        logger.error("Server", "Fyers startup failed, continuing without live market data", { error: err.message });
    }
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
        // X3: stop cron task so no new square-off fires during drain
        stopSquareOffJob();
        stopOpsAlarms();
        await stopEventBackbone();
        stopAllLanes();
        stopFyersWebSocket();
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
