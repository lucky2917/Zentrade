import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { initDB } from "./config/db.js";
import logger from "./utils/logger.js";
import authRoutes from "./routes/auth.js";
import stockRoutes from "./routes/stocks.js";
import tradeRoutes from "./routes/trade.js";
import portfolioRoutes from "./routes/portfolio.js";
import orderRoutes from "./routes/orders.js";
import chartRoutes from "./routes/chart.js";
import indicesRoutes from "./routes/indices.js";
import marketRoutes from "./routes/market.js";
import watchlistRoutes from "./routes/watchlist.js";
import startMarketWorker from "./services/marketWorker.js";
import startWebSocketBroadcaster from "./services/websocket.js";
import { startSquareOffJob } from "./services/squareOff.js";

const app = express();
const server = createServer(app);
const io = new Server(server, {
    cors: {
        origin: ["http://localhost:5173", "http://localhost:3000"],
        methods: ["GET", "POST"],
    },
});

app.use(cors());
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/stocks", stockRoutes);
app.use("/api/trade", tradeRoutes);
app.use("/api/portfolio", portfolioRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/chart", chartRoutes);
app.use("/api/indices", indicesRoutes);
app.use("/api/market", marketRoutes);
app.use("/api/watchlist", watchlistRoutes);

app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: Date.now() });
});

const PORT = process.env.PORT || 5000;

const start = async () => {
    await initDB();
    startMarketWorker();
    startWebSocketBroadcaster(io);
    startSquareOffJob();

    server.listen(PORT, () => {
        logger.info("Server", `Zentrade server running on port ${PORT}`);
    });
};

start();

/*
 * main server entry point. sets up express, socket.io, cors, and
 * mounts all the api routes. on startup it inits the db schema,
 * kicks off the market data worker, starts the websocket price
 * broadcaster, and schedules the auto square-off cron job.
 * basically everything starts from here.
 */
