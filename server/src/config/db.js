import pg from "pg";
import logger from "../utils/logger.js";
import { runMigrations } from "./migrations.js";

const isLocal = (process.env.DATABASE_URL ?? "").includes("localhost");

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

const initDB = async () => {
  await runMigrations(pool);
  logger.info("Database", "Schema ready");
};

export { pool, initDB };
