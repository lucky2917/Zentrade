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
      password_hash VARCHAR(255),
      google_id VARCHAR(255) UNIQUE,
      name VARCHAR(255),
      balance_paise BIGINT NOT NULL DEFAULT 100000000,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const googleIdCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'google_id'
  `);
  if (googleIdCheck.rows.length === 0) {
    await pool.query(`ALTER TABLE users ADD COLUMN google_id VARCHAR(255) UNIQUE`);
    await pool.query(`ALTER TABLE users ADD COLUMN name VARCHAR(255)`);
    await pool.query(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS portfolio (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      symbol VARCHAR(20) NOT NULL,
      quantity INTEGER NOT NULL,
      avg_price_paise BIGINT NOT NULL,
      order_mode VARCHAR(10) NOT NULL DEFAULT 'DELIVERY',
      margin_used_paise BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(user_id, symbol, order_mode)
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
      order_mode VARCHAR(10) NOT NULL DEFAULT 'INTRADAY',
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

  const orderModePortfolioCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'portfolio' AND column_name = 'order_mode'
  `);
  if (orderModePortfolioCheck.rows.length === 0) {
    await pool.query(`ALTER TABLE portfolio ADD COLUMN order_mode VARCHAR(10) NOT NULL DEFAULT 'DELIVERY'`);
    await pool.query(`ALTER TABLE portfolio ADD COLUMN margin_used_paise BIGINT NOT NULL DEFAULT 0`);
    await pool.query(`ALTER TABLE portfolio DROP CONSTRAINT IF EXISTS portfolio_user_id_symbol_key`);
    await pool.query(`
      ALTER TABLE portfolio ADD CONSTRAINT portfolio_user_id_symbol_mode_key UNIQUE(user_id, symbol, order_mode)
    `);
  }

  const orderModeOrdersCheck = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'orders' AND column_name = 'order_mode'
  `);
  if (orderModeOrdersCheck.rows.length === 0) {
    await pool.query(`ALTER TABLE orders ADD COLUMN order_mode VARCHAR(10) NOT NULL DEFAULT 'INTRADAY'`);
  }

  logger.info("Database", "Schema initialized");
};

export { pool, initDB };

/*
 * postgres setup with auto-migration. creates the connection pool
 * and runs all CREATE TABLE statements on boot. the portfolio table
 * has a unique constraint on (user_id, symbol, order_mode) so a
 * user can hold both intraday and delivery positions in the same
 * stock at the same time. the migration blocks at the bottom handle
 * adding the new order_mode and margin_used_paise columns to
 * existing databases without dropping data.
 */
