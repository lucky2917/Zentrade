import pg from "pg";
import logger from "../utils/logger.js";
import { runMigrations } from "./migrations.js";

// TLS is configured explicitly via the `ssl` pool option below. An sslmode
// query param in the URL would fight with it and trips pg's noisy
// "sslmode aliases" deprecation warning, so strip it from the string.
const stripSslParams = (url) => {
    if (!url) return url;
    try {
        const u = new URL(url);
        u.searchParams.delete("sslmode");
        u.searchParams.delete("ssl");
        return u.toString();
    } catch {
        return url;
    }
};

const connectionString = stripSslParams(process.env.DATABASE_URL);

// Loopback only. A substring test for "localhost" both misses 127.0.0.1 and
// matches hostile hostnames like localhost.example.com, so the host is parsed
// and compared exactly. Local Postgres has no TLS, and asking for it fails
// with "The server does not support SSL connections".
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const isLoopback = (url) => {
    if (!url) return false;
    try {
        return LOOPBACK_HOSTS.has(new URL(url).hostname);
    } catch {
        return false;
    }
};
const isLocal = isLoopback(connectionString);

const buildSsl = () => {
    if (isLocal) return false;
    if (process.env.DB_CA_CERT) {
        // H6: validate server certificate when a CA cert is provided
        return { rejectUnauthorized: true, ca: process.env.DB_CA_CERT };
    }
    // Providers with publicly-trusted certs (Neon, Supabase, RDS with public
    // CA) verify fine against the system root store — set DB_SSL_VERIFY=true
    if (process.env.DB_SSL_VERIFY === "true") {
        return { rejectUnauthorized: true };
    }
    // H6: without verification enabled we can't validate the server; log a
    // warning so this is visible in deploy logs. Set DB_SSL_VERIFY=true
    // (public CA) or DB_CA_CERT (self-signed provider CA) to harden this.
    logger.warn("Database", "DB TLS is on but cert validation is disabled — set DB_SSL_VERIFY=true (or DB_CA_CERT)");
    return { rejectUnauthorized: false };
};

const pool = new pg.Pool({
    connectionString,
    ssl: buildSsl(),
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 10,
});

const initDB = async () => {
    await runMigrations(pool);
    logger.info("Database", "Schema ready");
};

export { pool, initDB };
