#!/usr/bin/env node
import "dotenv/config";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// One command that starts everything ZenTrade needs to run a paper session.
//
//   1. checks the dependencies that must exist, and names exactly what is
//      missing rather than starting in a degraded state that looks healthy
//   2. builds and starts the Go fast market plane, unless it is turned off
//   3. starts the autonomous runtime — the Senior Trader Brain, the risk gate
//      and paper execution — in its own process
//
// It does NOT start the API. That is `npm run server`, in its own terminal,
// and it owns the Fyers vendor edge, the socket and the cockpit. Keeping them
// apart is what lets the trader restart without dropping the feed, and what
// makes it impossible for two runtimes to exist.
//
// It owns the shutdown ordering too: the plane is stopped after the brain, so
// the brain never loses its market feed while it is still reasoning.
//
// PAPER ONLY. There is no flag here that enables live execution, because no
// order-placement code exists anywhere in the repository.

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const GO_DIR = join(API_DIR, "../../go");
const BIN_DIR = join(GO_DIR, "bin");
const PLANE_BIN = join(BIN_DIR, "marketdatad");

const PLANE_MODE = (process.env.ZENTRADE_FAST_PLANE ?? "shadow").toLowerCase();
const PORT = process.env.PORT ?? 5000;

const say = (line = "") => process.stdout.write(`${line}\n`);
const fail = (title, detail) => {
    say("");
    say(`  CANNOT START — ${title}`);
    for (const line of detail) say(`    ${line}`);
    say("");
    process.exit(1);
};

// ---- dependency checks -----------------------------------------------------

const REQUIRED_ENV = ["DATABASE_URL", "REDIS_URL", "JWT_SECRET"];

const checkEnvironment = () => {
    const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
    if (missing.length) {
        fail("required configuration is missing", [
            ...missing.map((k) => `${k} is not set`),
            "",
            "Set them in apps/api/.env and try again.",
        ]);
    }
    if ((process.env.JWT_SECRET ?? "").length < 32) {
        fail("JWT_SECRET is too short", ["It must be at least 32 characters."]);
    }
};

const checkServices = async () => {
    const { pool } = await import("../src/config/db.js");
    const { default: redis } = await import("../src/config/redis.js");
    const problems = [];
    try { await pool.query("SELECT 1"); } catch (err) {
        problems.push(`Postgres is unreachable: ${err.message}`);
    }
    try { await redis.ping(); } catch (err) {
        problems.push(`Redis is unreachable: ${err.message}`);
    }
    await pool.end().catch(() => {});
    await redis.quit().catch(() => {});
    if (problems.length) {
        fail("a required service is unavailable", [
            ...problems, "", "The brain cannot run without both.",
        ]);
    }
};

// ---- the Go fast plane -----------------------------------------------------

const buildPlane = () => {
    try {
        execFileSync("go", ["version"], { stdio: "ignore" });
    } catch {
        fail("the Go toolchain is not installed", [
            "The fast market plane is written in Go and cannot be built.",
            "",
            "Install Go, or start without it:",
            "  ZENTRADE_FAST_PLANE=off npm run agent",
        ]);
    }
    mkdirSync(BIN_DIR, { recursive: true });
    say("  building the fast market plane…");
    try {
        execFileSync("go", ["build", "-o", PLANE_BIN, "./cmd/marketdatad"],
                     { cwd: GO_DIR, stdio: "pipe" });
    } catch (err) {
        fail("the fast market plane did not build", [
            String(err.stderr ?? err.message).trim().split("\n").slice(0, 8).join("\n    "),
        ]);
    }
};

const startPlane = () => {
    const child = spawn(PLANE_BIN,
        ["-mode", PLANE_MODE, "-sweep", "1s", "-health", "127.0.0.1:5601"],
        { env: process.env, stdio: ["ignore", "pipe", "pipe"] });

    const relay = (stream, prefix) => stream.on("data", (chunk) => {
        for (const line of String(chunk).trimEnd().split("\n")) {
            if (line) say(`  [plane] ${prefix}${line}`);
        }
    });
    relay(child.stdout, "");
    relay(child.stderr, "");
    return child;
};

// A plane that exits immediately is almost always a second instance losing the
// ownership race. Saying so beats printing a stack trace.
const waitForPlane = (child) => new Promise((resolve) => {
    let settled = false;
    const done = (ok, reason) => { if (!settled) { settled = true; resolve({ ok, reason }); } };
    child.once("exit", (code) => done(false,
        code === 1
            ? "another instance already owns the market-data role"
            : `the plane exited with code ${code}`));
    setTimeout(() => done(true, null), 1500);
});

// ---- start -----------------------------------------------------------------

// The autonomous runtime, in its own process. Not the API: the API is started
// separately with `npm run server` and owns the vendor edge, the socket and the
// cockpit. Two processes, one runtime.
const startTrader = () => spawn(process.execPath, ["src/agent.js"], {
    cwd: API_DIR,
    env: { ...process.env, ZENTRADE_FAST_PLANE: PLANE_MODE },
    stdio: "inherit",
});

const main = async () => {
    say("");
    say("  ZEN TRADE AI TRADER");
    say("  ===================");
    say("");
    say("  MODE: PAPER");
    say("");

    checkEnvironment();
    await checkServices();

    let plane = null;
    if (PLANE_MODE === "off") {
        say("  FAST PLANE: OFF (the Node reflex is protecting)");
    } else {
        if (!existsSync(PLANE_BIN)) buildPlane();
        plane = startPlane();
        const { ok, reason } = await waitForPlane(plane);
        if (!ok) {
            fail("the fast market plane could not start", [
                reason,
                "",
                "Start without it if that is what you want:",
                "  ZENTRADE_FAST_PLANE=off npm run agent",
            ]);
        }
        say(`  FAST PLANE: ACTIVE (${PLANE_MODE})`);
    }

    const trader = startTrader();

    // Shutdown order matters. The brain stops first so it can drain and
    // reconcile while it still has a market feed; the plane follows.
    let shuttingDown = false;
    const shutdown = (signal) => {
        if (shuttingDown) return;
        shuttingDown = true;
        say(`\n  ${signal} — stopping the trader, then the plane`);
        trader.kill(signal);
        setTimeout(() => plane?.kill("SIGTERM"), 1500);
        setTimeout(() => process.exit(0), 6000).unref();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));

    trader.once("exit", (code) => {
        if (!shuttingDown) {
            say(`\n  the trader exited with code ${code}; stopping the plane`);
            plane?.kill("SIGTERM");
            process.exit(code ?? 1);
        }
    });
    plane?.once("exit", (code) => {
        if (!shuttingDown) {
            say(`\n  the fast plane exited with code ${code}`);
            say("  the trader keeps running; its local reflex is still protecting.");
        }
    });
};

main().catch((err) => {
    say(`\n  agent failed to start: ${err.message}\n`);
    process.exit(1);
});
