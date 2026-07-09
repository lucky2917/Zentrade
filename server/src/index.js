import "dotenv/config";
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

const app = express();
app.set("trust proxy", 1);
const server = createServer(app);

// L1: origins driven by env — localhost only included in dev
const isProd = process.env.NODE_ENV === "production";
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

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use("/api", apiLimiter);

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: "Too many attempts, please try again later" },
});
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);

// H4: separate limiter for token refresh — higher ceiling, not auth-critical
const refreshLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many refresh attempts" },
});
app.use("/api/auth/refresh", refreshLimiter);

const fyersLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use("/fyers", fyersLimiter);

const tradeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
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
app.use("/fyers", fyersRoutes);

app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
});

const PORT = process.env.PORT || 5000;

const start = async () => {
    if (!process.env.JWT_SECRET) {
        logger.error("Server", "JWT_SECRET not set, exiting");
        process.exit(1);
    }

    await redis.ping();
    logger.info("Server", "Redis connection verified");

    await initDB();

    startMarketWorker();
    startWebSocketBroadcaster(io);
    startSquareOffJob();

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

    server.close(() => logger.info("Server", "HTTP server closed"));

    try {
        // X3: stop cron task so no new square-off fires during drain
        stopSquareOffJob();
        stopAllLanes();
        stopFyersWebSocket();
        await pool.end();
        await redis.quit();
    } catch (err) {
        logger.error("Server", "Error during shutdown", { error: err.message });
    }

    setTimeout(() => process.exit(0), 2000);
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
