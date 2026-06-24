import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import swaggerUi from "swagger-ui-express";
import { initDB } from "./config/db.js";
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
import startMarketWorker, { INDICES } from "./services/marketWorker.js";
import startWebSocketBroadcaster from "./services/websocket.js";
import { startSquareOffJob } from "./services/squareOff.js";
import { initFyersAuth, isConfigured as isFyersConfigured } from "./services/fyers/fyersAuth.js";
import { connect as connectFyersWebSocket, subscribe as subscribeFyersWebSocket } from "./services/fyers/fyersWebSocket.js";
import { startAuthWatchdog } from "./services/fyers/authWatchdog.js";
import { STOCKS } from "./config/stocks.js";

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: [process.env.FRONTEND_URL, "http://localhost:5173", "http://localhost:3000"],
        methods: ["GET", "POST"],
    },
});

app.use(cors({
    origin: [process.env.FRONTEND_URL, "http://localhost:5173", "http://localhost:3000"]
}));
app.use(express.json());

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: "Zentrade API Docs",
    swaggerOptions: { persistAuthorization: true },
}));

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

app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
});

const PORT = process.env.PORT || 5000;

const start = async () => {
    await initDB();

    await initFyersAuth();
    startAuthWatchdog();
    if (isFyersConfigured()) {
        await connectFyersWebSocket();
        subscribeFyersWebSocket([...STOCKS.map((s) => s.symbol), ...INDICES.map((i) => i.symbol)]);
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
