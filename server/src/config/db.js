import pg from "pg";
import logger from "../utils/logger.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

const initDB = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      balance_paise BIGINT NOT NULL DEFAULT 100000000,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      symbol VARCHAR(20) NOT NULL,
      quantity INTEGER NOT NULL,
      avg_price_paise BIGINT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, symbol)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      symbol VARCHAR(20) NOT NULL,
      type VARCHAR(4) NOT NULL,
      quantity INTEGER NOT NULL,
      price_paise BIGINT NOT NULL,
      total_value_paise BIGINT NOT NULL,
      brokerage_paise BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      symbol VARCHAR(20) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, symbol)
    )
  `);

  const brokerageCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'brokerage_paise'
  `);

  if (brokerageCheck.rows.length === 0) {
    await pool.query(`ALTER TABLE orders ADD COLUMN brokerage_paise BIGINT NOT NULL DEFAULT 0`);
  }

  logger.info("Database", "Schema initialized");
};

export { pool, initDB };

/*
 * this is the postgres setup file. creates the connection pool and
 * runs all the CREATE TABLE statements when the server boots up.
 * tables: users, portfolio, orders, watchlist. pretty much every
 * route file that touches the database imports pool from here,
 * and index.js calls initDB() on startup to make sure schema exists.
 */
