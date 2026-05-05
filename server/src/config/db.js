import pg from "pg";
import logger from "../utils/logger.js";
import { runMigrations } from "./migrations.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const initDB = async () => {
  await runMigrations(pool);
  logger.info("Database", "Schema ready");
};

export { pool, initDB };
