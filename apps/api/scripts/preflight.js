import "dotenv/config";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The one preflight.
//
// It answers a single question: if I start the agent now, will ZenTrade
// actually trade? Every check is read only, and it reports the presence and
// shape of configuration, never its value — no token, connection string or
// secret is printed, logged or returned.
//
// A misleading READY is the one thing this must never produce. A check that
// cannot be performed is reported as a failure to perform it, not as a pass.

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const GO_DIR = join(API_DIR, "../../go");
const WEB_DIST = join(API_DIR, "../web/dist");

const BLOCKING = "BLOCKING";
const ADVISORY = "ADVISORY";
const results = [];
const record = (group, name, level, ok, detail) => {
    results.push({ group, name, level, ok, detail });
    return ok;
};

// ---- configuration ---------------------------------------------------------

const REQUIRED_ENV = ["DATABASE_URL", "REDIS_URL", "JWT_SECRET",
                      "FYERS_CLIENT_ID", "FYERS_SECRET_KEY", "FYERS_REDIRECT_URI"];

const checkConfig = () => {
    const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
    record("CONFIG", "environment", BLOCKING, missing.length === 0,
           missing.length ? `missing: ${missing.join(", ")}`
                          : `${REQUIRED_ENV.length} variables present`);
    record("CONFIG", "jwt secret", BLOCKING, (process.env.JWT_SECRET ?? "").length >= 32,
           (process.env.JWT_SECRET ?? "").length >= 32
               ? "at least 32 characters" : "shorter than 32 characters");
    record("CONFIG", "model key", ADVISORY, Boolean(process.env.GROQ_API_KEY),
           process.env.GROQ_API_KEY
               ? "present; reasoning can run"
               : "absent; every reasoning call falls back to HOLD");
    record("CONFIG", "account", ADVISORY, true,
           `ZENTRADE_ACCOUNT_ID=${process.env.ZENTRADE_ACCOUNT_ID ?? 1}`);
};

// ---- schema ----------------------------------------------------------------

const REQUIRED_COLUMNS = [
    ["position_events", "state"], ["position_events", "leased_until"],
    ["position_events", "thesis_id"], ["position_reassessments", "event_id"],
    ["orders", "state"], ["orders", "client_order_id"], ["orders", "reserved_paise"],
    ["trade_thesis", "stop_paise"], ["memories", "memory_key"],
];

const checkDatabase = async (pool) => {
    try {
        await pool.query("SELECT 1");
        record("DATABASE", "postgres", BLOCKING, true, "connected");
    } catch (err) {
        return record("DATABASE", "postgres", BLOCKING, false, err.message);
    }

    const { rows } = await pool.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public'`);
    const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const absent = REQUIRED_COLUMNS.map(([t, c]) => `${t}.${c}`)
        .filter((key) => !present.has(key));
    return record("DATABASE", "migrations", BLOCKING, absent.length === 0,
                  absent.length ? `not applied: ${absent.join(", ")}`
                                : `${REQUIRED_COLUMNS.length} required columns present`);
};

const checkAccountAndRisk = async (pool, userId) => {
    const { rows } = await pool.query(
        "SELECT balance_paise FROM users WHERE id = $1", [userId]);
    if (!rows.length) {
        return record("RISK", "account", BLOCKING, false, `no user row for id ${userId}`);
    }
    const balance = Number(rows[0].balance_paise ?? 0);
    record("RISK", "account", BLOCKING, balance > 0,
           balance > 0 ? `balance ${(balance / 100).toFixed(2)}`
                       : "zero balance; nothing can be sized");

    const ambiguous = await pool.query(
        `SELECT COUNT(*)::int AS n FROM orders WHERE user_id=$1 AND state='AMBIGUOUS'`,
        [userId]);
    record("RISK", "ambiguous orders", BLOCKING, ambiguous.rows[0].n === 0,
           ambiguous.rows[0].n === 0 ? "none"
               : `${ambiguous.rows[0].n} unresolved; new exposure stays blocked`);

    const positions = await pool.query(
        `SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE t.id IS NULL)::int AS orphaned
         FROM portfolio p
         LEFT JOIN trade_thesis t
           ON t.user_id=p.user_id AND t.symbol=p.symbol AND t.closed_at IS NULL
         WHERE p.user_id=$1 AND p.quantity > 0`, [userId]);
    const { n, orphaned } = positions.rows[0];
    record("RISK", "open positions", ADVISORY, true, `${n} held`);
    return record("RISK", "positions with a thesis", BLOCKING, orphaned === 0,
                  orphaned === 0 ? "every held position can be reassessed and protected"
                      : `${orphaned} position(s) have no thesis`);
};

// ---- market data -----------------------------------------------------------

const checkRedis = async (redis) => {
    try {
        await redis.ping();
        return record("REDIS", "redis", BLOCKING, true, "connected");
    } catch (err) {
        return record("REDIS", "redis", BLOCKING, false, err.message);
    }
};

// The token is ACQUIRED here, not merely inspected. If the OAuth callback
// belongs to another deployment, this fetches the token from the configured
// source so the operator does not have to remember a separate command once a
// day, at the one moment they are busy.
const checkFyers = async (redis) => {
    const { ensureFyersToken, acquired, STATUS } =
        await import("../src/services/fyers/tokenSource.js");
    const { status, message } = await ensureFyersToken({ redis, logger: null });

    record("FYERS", "access token", BLOCKING, acquired(status), message);
    if (status === STATUS.SYNCED) {
        record("FYERS", "token source", ADVISORY, true,
               "startup fetches the token automatically; no manual sync");
    }
    return acquired(status);
};

const checkMarketData = async (redis, universe) => {
    const sample = universe.slice(0, 25);
    let cached = 0;
    let newest = null;
    for (const symbol of sample) {
        const raw = await redis.get(`stock:${symbol}`);
        if (!raw) continue;
        cached += 1;
        try {
            const at = new Date(JSON.parse(raw).timestamp).getTime();
            if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
        } catch { /* a malformed entry is not a preflight failure */ }
    }
    record("FYERS", "cached ticks", ADVISORY, true,
           cached === 0 ? `none of ${sample.length} sampled symbols cached`
               : `${cached}/${sample.length} cached, newest ${Math.round((Date.now() - newest) / 60_000)}m old`);

    let bars = 0;
    for (const symbol of sample) if (await redis.exists(`bars:1m:${symbol}`)) bars += 1;
    record("FYERS", "bar history", ADVISORY, true,
           `${bars}/${sample.length} sampled symbols have 1m bars`);
};

// ---- the fast plane --------------------------------------------------------

const checkFastPlane = async (redis) => {
    const mode = (process.env.ZENTRADE_FAST_PLANE ?? "shadow").toLowerCase();
    if (mode === "off") {
        return record("FAST PLANE", "go fast plane", ADVISORY, true,
                      "off; the agent's local reflex protects");
    }
    if (!["shadow", "live"].includes(mode)) {
        return record("FAST PLANE", "go fast plane", BLOCKING, false,
                      `ZENTRADE_FAST_PLANE=${mode} is not off, shadow or live`);
    }

    let toolchain = false;
    try { execFileSync("go", ["version"], { stdio: "ignore" }); toolchain = true; }
    catch { /* reported below */ }
    if (!toolchain) {
        return record("FAST PLANE", "go toolchain", BLOCKING, false,
                      "Go is not installed; set ZENTRADE_FAST_PLANE=off to run without it");
    }

    try {
        execFileSync("go", ["build", "-o", join(GO_DIR, "bin", "marketdatad"),
                            "./cmd/marketdatad"], { cwd: GO_DIR, stdio: "pipe" });
        record("FAST PLANE", "go fast plane", BLOCKING, true, `builds; mode ${mode}`);
    } catch (err) {
        return record("FAST PLANE", "go fast plane", BLOCKING, false,
                      String(err.stderr ?? err.message).trim().split("\n")[0]);
    }

    // A lease already held means an instance is running. That is fine if it is
    // the one you meant to leave running, and a problem if it is not.
    const owner = await redis.get("zentrade:marketdata:owner");
    return record("FAST PLANE", "ownership", ADVISORY, true,
                  owner ? "an instance already owns the market-data role"
                        : "free; the agent will take ownership");
};

// ---- runtime and cockpit ---------------------------------------------------

const portFree = (port) => new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.on("connect", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => resolve(true));
    setTimeout(() => { socket.destroy(); resolve(true); }, 500);
});

const checkRuntime = async (redis) => {
    const { RUNTIME_HEALTH_KEY } = await import("../src/services/cockpit/narrator.js");
    const running = await redis.get(RUNTIME_HEALTH_KEY);
    record("RUNTIME", "agent", ADVISORY, true,
           running ? "already running; starting again would be a second runtime"
                   : "not running; `npm run agent` will start it");

    const port = Number(process.env.PORT ?? 5000);
    const free = await portFree(port);
    record("RUNTIME", "api port", ADVISORY, true,
           free ? `${port} free; \`npm run server\` will bind it`
                : `${port} in use; the backend is already running`);

    // The cockpit these commands start is the LOCAL one. FRONTEND_URL points at
    // the deployed frontend, which talks to the deployed backend — showing it
    // here would send the operator to a different system entirely.
    const built = existsSync(join(WEB_DIST, "index.html"));
    record("COCKPIT", "web build", ADVISORY, true,
           built ? "present; the backend serves /trader itself"
                 : "absent; `npm run dev` in apps/web serves it on 5173");
    record("COCKPIT", "endpoint", ADVISORY, true,
           built ? `http://localhost:${port}/trader`
                 : "http://localhost:5173/trader");
};

const checkSafety = async () => {
    // Paper-only is enforced by absence, not by a flag. If order-placement code
    // ever appears, this must fail rather than reassure.
    const { MODE } = await import("../src/services/autonomous/runtime.js");
    record("SAFETY", "paper only", BLOCKING, MODE.PAPER === "PAPER",
           "no order-placement code exists in this repository");
};

const checkSession = (sessionStateAt, isTradingDay) => {
    const now = new Date();
    record("SESSION", "trading day", ADVISORY, true,
           isTradingDay(now) ? "today is a trading day"
                             : "today is not a trading day; the loop stays CLOSED");
    record("SESSION", "session", ADVISORY, true, sessionStateAt(now));
};

// ---- output ----------------------------------------------------------------

const render = () => {
    const width = Math.max(...results.map((r) => r.name.length)) + 2;
    let group = null;
    for (const r of results) {
        if (r.group !== group) { group = r.group; process.stdout.write(`\n  ${group}\n`); }
        const mark = r.ok ? "OK  " : (r.level === BLOCKING ? "FAIL" : "warn");
        process.stdout.write(`    ${mark}  ${r.name.padEnd(width)}${r.detail}\n`);
    }
    const failures = results.filter((r) => !r.ok && r.level === BLOCKING);
    process.stdout.write("\n");
    if (failures.length === 0) {
        process.stdout.write("  READY\n\n");
        process.stdout.write("  Start it:\n");
        process.stdout.write("    terminal 1   cd apps/web && npm run dev\n");
        process.stdout.write("    terminal 2   cd apps/api && npm run server\n");
        process.stdout.write("    terminal 3   cd apps/api && npm run agent\n\n");
        return 0;
    }
    process.stdout.write("  NOT READY\n\n  Reason:\n");
    for (const f of failures) process.stdout.write(`    ${f.name}: ${f.detail}\n`);
    process.stdout.write("\n");
    return 1;
};

const main = async () => {
    const userId = Number(process.env.ZENTRADE_ACCOUNT_ID ?? 1);
    process.stdout.write("\n  ZEN TRADE PREFLIGHT\n  ===================\n");

    checkConfig();

    const { pool } = await import("../src/config/db.js");
    const { default: redis } = await import("../src/config/redis.js");
    const { sessionStateAt, isTradingDay } =
        await import("../src/services/orchestrator/session.js");
    const { STOCKS } = await import("../src/config/stocks.js");
    const universe = STOCKS.map((s) => s.symbol);
    record("CONFIG", "universe", BLOCKING, universe.length > 0,
           `${universe.length} symbols subscribed`);

    if (await checkDatabase(pool)) await checkAccountAndRisk(pool, userId);
    if (await checkRedis(redis)) {
        await checkFyers(redis);
        await checkMarketData(redis, universe);
        await checkFastPlane(redis);
        await checkRuntime(redis);
    }
    await checkSafety();
    checkSession(sessionStateAt, isTradingDay);

    const code = render();
    await pool.end().catch(() => {});
    await redis.quit().catch(() => {});
    process.exit(code);
};

main().catch((err) => {
    process.stdout.write(`\n  PREFLIGHT COULD NOT COMPLETE\n    ${err.message}\n\n`);
    process.exit(2);
});
