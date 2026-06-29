import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
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
import { startSquareOffJob } from "./services/squareOff.js";
import { initFyersAuth, isConfigured as isFyersConfigured } from "./services/fyers/fyersAuth.js";
import { connect as connectFyersWebSocket, subscribe as subscribeFyersWebSocket, stop as stopFyersWebSocket } from "./services/fyers/fyersWebSocket.js";
import { startWatchdog } from "./services/fyers/authWatchdog.js";
import { startAllLanes, stopAllLanes } from "./services/fyers/laneManager.js";
import { startPreMarketScanner } from "./services/fyers/preMarketScanner.js";
import { startSymbolManager } from "./services/fyers/symbolManager.js";
import fyersRoutes from "./routes/fyers.js";
import { STOCKS } from "./config/stocks.js";

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: [process.env.FRONTEND_URL, "http://localhost:5173", "http://localhost:3000"],
        methods: ["GET", "POST"],
    },
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
    origin: [process.env.FRONTEND_URL, "http://localhost:5173", "http://localhost:3000"]
}));
app.use(express.json());

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

if (process.env.NODE_ENV !== "production") {
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
    await initDB();

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

    startMarketWorker();
    startWebSocketBroadcaster(io);
    startSquareOffJob();

    server.listen(PORT, () => {
        logger.info("Server", `Zentrade server running on port ${PORT}`);
    });
};

start();

let shuttingDown = false;
const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Server", `${signal} received, shutting down gracefully`);

    server.close(() => logger.info("Server", "HTTP server closed"));

    try {
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
