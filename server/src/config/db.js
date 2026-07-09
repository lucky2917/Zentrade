import pg from "pg";
import logger from "../utils/logger.js";
import { runMigrations } from "./migrations.js";

const isLocal = (process.env.DATABASE_URL ?? "").includes("localhost");

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
    connectionString: process.env.DATABASE_URL,
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
