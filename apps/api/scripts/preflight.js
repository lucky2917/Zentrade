import "dotenv/config";

// Pre-session preflight.
//
// One command that answers "if I start the server now, will the brain actually
// trade?". Every check is read only. It reports the presence and shape of
// configuration, never its value: no token, connection string or secret is
// printed, logged or returned.
//
// Exit code 0 means every blocking check passed. Anything else means the
// session should not be started until the named check is fixed.

const BLOCKING = "BLOCKING";
const ADVISORY = "ADVISORY";

const results = [];
const record = (name, level, ok, detail) => {
    results.push({ name, level, ok, detail });
    return ok;
};

const REQUIRED_ENV = [
    "DATABASE_URL", "REDIS_URL", "JWT_SECRET",
    "FYERS_CLIENT_ID", "FYERS_SECRET_KEY", "FYERS_REDIRECT_URI",
];

const checkEnv = () => {
    const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
    record("environment", BLOCKING, missing.length === 0,
           missing.length ? `missing: ${missing.join(", ")}` : `${REQUIRED_ENV.length} variables present`);

    const secret = process.env.JWT_SECRET ?? "";
    record("jwt secret length", BLOCKING, secret.length >= 32,
           secret.length >= 32 ? "at least 32 characters" : "shorter than 32 characters");

    // Not blocking, because `npm run brain` sets it. It is reported so the
    // operator knows which of the two start commands actually runs the brain.
    const autonomous = process.env.ZENTRADE_AUTONOMOUS === "true";
    record("autonomous flag", ADVISORY, true,
           autonomous
               ? "set; `npm start` will start the brain"
               : "not set; start with `npm run brain`, which sets it");

    record("account id", ADVISORY, true,
           `ZENTRADE_ACCOUNT_ID=${process.env.ZENTRADE_ACCOUNT_ID ?? 1}`);

    const plane = String(process.env.ZENTRADE_FAST_PLANE ?? "off").toLowerCase();
    record("fast plane", ADVISORY, true,
           plane === "off"
               ? "off; the Node reflex is the only protection, which is the default"
               : `${plane}; marketdatad must be running and holding the lease`);

    record("model key", ADVISORY, Boolean(process.env.GROQ_API_KEY),
           process.env.GROQ_API_KEY
               ? "present, reasoning can run"
               : "absent; every reasoning call will fall back to HOLD");
};

// The columns the autonomous path writes. A migration that has not run turns
// into a constraint violation on the first event of the session, which is the
// worst possible time to discover it.
const REQUIRED_COLUMNS = [
    ["position_events", "state"],
    ["position_events", "leased_until"],
    ["position_events", "thesis_id"],
    ["position_reassessments", "event_id"],
    ["orders", "state"],
    ["orders", "client_order_id"],
    ["orders", "reserved_paise"],
    ["trade_thesis", "stop_paise"],
];

const checkDatabase = async (pool) => {
    try {
        await pool.query("SELECT 1");
        record("database reachable", BLOCKING, true, "connected");
    } catch (err) {
        return record("database reachable", BLOCKING, false, err.message);
    }

    const { rows } = await pool.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public'`);
    const present = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const absent = REQUIRED_COLUMNS
        .map(([t, c]) => `${t}.${c}`)
        .filter((key) => !present.has(key));
    return record("schema migrations", BLOCKING, absent.length === 0,
                  absent.length ? `missing: ${absent.join(", ")}` : `${REQUIRED_COLUMNS.length} required columns present`);
};

const checkAccount = async (pool, userId) => {
    const { rows } = await pool.query(
        "SELECT balance_paise FROM users WHERE id = $1", [userId]);
    if (!rows.length) {
        return record("account", BLOCKING, false, `no user row for id ${userId}`);
    }
    const balance = Number(rows[0].balance_paise ?? 0);
    return record("account", BLOCKING, balance > 0,
                  balance > 0 ? `balance ${(balance / 100).toFixed(2)}` : "zero balance; nothing can be sized");
};

const checkExposure = async (pool, userId) => {
    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS ambiguous FROM orders
         WHERE user_id = $1 AND state = 'AMBIGUOUS'`, [userId]);
    const ambiguous = rows[0].ambiguous;
    record("ambiguous orders", BLOCKING, ambiguous === 0,
           ambiguous === 0 ? "none" : `${ambiguous} unresolved; new exposure stays blocked`);

    const open = await pool.query(
        `SELECT COUNT(*)::int AS n FROM orders
         WHERE user_id = $1 AND state IN ('NEW','ACCEPTED','WORKING','PARTIALLY_FILLED')`,
        [userId]);
    record("open orders", ADVISORY, true,
           open.rows[0].n === 0 ? "none carried over" : `${open.rows[0].n} carried over into the session`);

    // A position is bound to its thesis by (user, symbol) while the thesis is
    // open, the same join openPositions uses. A holding with no open thesis
    // cannot be reassessed and cannot be armed on the reflex lane.
    const positions = await pool.query(
        `SELECT COUNT(*)::int AS n,
                COUNT(*) FILTER (WHERE t.id IS NULL)::int AS orphaned
         FROM portfolio p
         LEFT JOIN trade_thesis t
           ON t.user_id = p.user_id AND t.symbol = p.symbol AND t.closed_at IS NULL
         WHERE p.user_id = $1 AND p.quantity > 0`, [userId]);
    const { n, orphaned } = positions.rows[0];
    record("open positions", ADVISORY, true, `${n} held`);
    record("positions with a thesis", BLOCKING, orphaned === 0,
           orphaned === 0
               ? "every held position can be reassessed"
               : `${orphaned} position(s) have no thesis and cannot be reassessed or protected`);
};

const checkRedis = async (redis) => {
    try {
        await redis.ping();
        record("redis reachable", BLOCKING, true, "connected");
    } catch (err) {
        return record("redis reachable", BLOCKING, false, err.message);
    }
    return true;
};

const checkFyers = async (getAccessToken, getTokenExpiry) => {
    const token = await getAccessToken();
    if (!token) {
        const reauth = `${process.env.FRONTEND_URL ?? ""}/reauth`;
        return record("fyers token", BLOCKING, false,
                      `absent; re-authenticate at ${reauth} before the open`);
    }
    const expiry = await getTokenExpiry();
    if (!expiry) {
        return record("fyers token", ADVISORY, true, "present, expiry unknown");
    }
    const minutes = Math.round((expiry - Date.now()) / 60_000);
    return record("fyers token", BLOCKING, minutes > 0,
                  minutes > 0
                      ? `present, valid for ${Math.floor(minutes / 60)}h ${minutes % 60}m`
                      : "expired; re-authenticate before the open");
};

const checkMarketData = async (redis, universe) => {
    const sample = universe.slice(0, 25);
    let cached = 0;
    let freshest = null;
    for (const symbol of sample) {
        const raw = await redis.get(`stock:${symbol}`);
        if (!raw) continue;
        cached += 1;
        try {
            const at = new Date(JSON.parse(raw).timestamp).getTime();
            if (Number.isFinite(at) && (freshest === null || at > freshest)) freshest = at;
        } catch { /* a malformed cache entry is not a preflight failure */ }
    }
    const ageMinutes = freshest === null ? null : Math.round((Date.now() - freshest) / 60_000);
    record("cached ticks", ADVISORY, true,
           cached === 0
               ? `none of ${sample.length} sampled symbols cached; expected before the first session`
               : `${cached}/${sample.length} cached, newest ${ageMinutes} minutes old`);

    let bars = 0;
    for (const symbol of sample) {
        if (await redis.exists(`bars:1m:${symbol}`)) bars += 1;
    }
    record("bar history", ADVISORY, true, `${bars}/${sample.length} sampled symbols have 1m bars`);
};

const checkSession = (sessionStateAt, isTradingDay) => {
    const now = new Date();
    const trading = isTradingDay(now);
    record("trading day", ADVISORY, true,
           trading ? "today is a trading day" : "today is not a trading day; the loop will stay CLOSED");
    record("session state", ADVISORY, true, sessionStateAt(now));
};

const render = () => {
    const width = Math.max(...results.map((r) => r.name.length));
    for (const r of results) {
        const mark = r.ok ? "ok  " : (r.level === BLOCKING ? "FAIL" : "warn");
        process.stdout.write(`  ${mark}  ${r.name.padEnd(width)}  ${r.detail}\n`);
    }
    const failures = results.filter((r) => !r.ok && r.level === BLOCKING);
    process.stdout.write("\n");
    if (failures.length === 0) {
        process.stdout.write("READY — start the server and the brain will run.\n");
        return 0;
    }
    process.stdout.write(`NOT READY — ${failures.length} blocking check(s) failed:\n`);
    for (const f of failures) process.stdout.write(`  - ${f.name}: ${f.detail}\n`);
    return 1;
};

const main = async () => {
    const userId = Number(process.env.ZENTRADE_ACCOUNT_ID ?? 1);
    process.stdout.write("\nZenTrade Brain preflight\n\n");

    checkEnv();

    const { pool } = await import("../src/config/db.js");
    const { default: redis } = await import("../src/config/redis.js");
    const { sessionStateAt, isTradingDay } = await import("../src/services/orchestrator/session.js");
    const { STOCKS } = await import("../src/config/stocks.js");
    const { getAccessToken, getTokenExpiry } = await import("../src/services/fyers/fyersAuth.js");

    const universe = STOCKS.map((s) => s.symbol);
    record("universe", BLOCKING, universe.length > 0, `${universe.length} symbols subscribed`);

    if (await checkDatabase(pool)) {
        await checkAccount(pool, userId);
        await checkExposure(pool, userId);
    }
    if (await checkRedis(redis)) {
        await checkFyers(getAccessToken, getTokenExpiry);
        await checkMarketData(redis, universe);
    }
    checkSession(sessionStateAt, isTradingDay);

    const code = render();
    await pool.end();
    await redis.quit();
    process.exit(code);
};

main().catch((err) => {
    process.stdout.write(`\npreflight could not complete: ${err.message}\n`);
    process.exit(2);
});
