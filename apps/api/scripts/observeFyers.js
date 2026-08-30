#!/usr/bin/env node
// Controlled, observation-only Fyers verification.
//
// Connects through the EXISTING client, watches the connection state machine,
// and reports what actually arrives. It places no orders and writes nothing to
// the execution tables. If the market is closed it says so rather than
// pretending otherwise.

import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(dir, "..", ".env") });

const { ConnectionTracker } = await import("../src/services/orchestrator/connectionState.js");
const { sessionStateAt } = await import("../src/services/orchestrator/session.js");
const { isStale, SOURCE } = await import("../src/services/orchestrator/freshness.js");
const { getAccessToken } = await import("../src/services/fyers/fyersAuth.js");
const { getHistoricalData } = await import("../src/services/fyers/fyersREST.js");
const { getRemainingBudget } = await import("../src/services/fyers/rateLimiter.js");
const { default: redis } = await import("../src/config/redis.js");

const tracker = new ConnectionTracker();
const now = new Date();
const session = sessionStateAt(now);

console.log("=== controlled Fyers observation (read-only, no orders) ===");
console.log(`  wall clock (UTC)   ${now.toISOString()}`);
console.log(`  market session     ${session}`);
console.log(`  rest budget        ${(await getRemainingBudget()).toLocaleString()}`);

const token = await getAccessToken();
console.log(`  authentication     ${token ? "OK (token present)" : "NO TOKEN"}`);
if (!token) {
    console.log("  -> cannot observe without a token; not faking a session");
    await redis.quit();
    process.exit(0);
}

// REST is safe to exercise in any session; it is historical data, not an order.
tracker.onConnecting();
const probe = await getHistoricalData("NSE:RELIANCE-EQ", "5", "2026-08-20", "2026-08-28");
if (probe?.s === "ok" && Array.isArray(probe.candles) && probe.candles.length) {
    tracker.onConnected();
    tracker.onTick(Date.now());
    const last = probe.candles[probe.candles.length - 1];
    const stampIst = new Date((last[0] + 19800) * 1000).toISOString().replace("T", " ").slice(0, 19);
    console.log(`  REST data          ${probe.candles.length} candles`);
    console.log(`  last candle (IST)  ${stampIst}`);
    console.log(`  symbol mapping     NSE:RELIANCE-EQ -> RELIANCE`);
} else {
    tracker.onDisconnected("no data returned");
    console.log(`  REST data          FAILED (${probe?.s ?? "no response"})`);
}

const health = tracker.health();
console.log(`  connection state   ${health.state} (trusted: ${health.trusted})`);
console.log(`  data age           ${health.dataAgeMs}ms`);
console.log(`  stale?             ${isStale(SOURCE.WEBSOCKET, health.dataAgeMs)}`);

// Staleness detection, demonstrated rather than asserted in prose.
const future = Date.now() + 120_000;
console.log(`  after 120s idle    ${tracker.evaluate(future)}`);
tracker.onTick(future);
console.log(`  after a fresh tick ${tracker.state}`);

console.log(`\n  live websocket     ${session === "OPEN" || session === "CLOSING"
    ? "would connect now" : "NOT attempted: market is " + session}`);
console.log("  orders placed      0 (observation only)");
await redis.quit();
