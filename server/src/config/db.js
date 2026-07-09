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
const isLocal = (connectionString ?? "").includes("localhost");

const buildSsl = () => {
    if (isLocal) return false;
    if (process.env.DB_CA_CERT) {
        // H6: validate server certificate when a CA cert is provided
        return { rejectUnauthorized: true, ca: process.env.DB_CA_CERT };
    }
    // H6: without a CA cert we can't validate the server; log a warning so this
    // is visible in deploy logs. Set DB_CA_CERT to the PEM from your provider
    // (Render: Settings → "SSL Certificate") to harden this.
    logger.warn("Database", "DB_CA_CERT not set — TLS is on but cert validation is disabled");
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
