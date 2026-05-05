import logger from "../utils/logger.js";

const migrations = [
  {
    id: 1,
    name: "create_users_table",
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        balance_paise BIGINT NOT NULL DEFAULT 100000000,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `,
  },
  {
    id: 2,
    name: "create_portfolio_table",
    sql: `
      CREATE TABLE IF NOT EXISTS portfolio (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        symbol VARCHAR(20) NOT NULL,
        quantity INTEGER NOT NULL,
        avg_price_paise BIGINT NOT NULL,
        UNIQUE(user_id, symbol)
      )
    `,
  },
  {
    id: 3,
    name: "create_orders_table",
    sql: `
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        symbol VARCHAR(20) NOT NULL,
        type VARCHAR(4) NOT NULL,
        quantity INTEGER NOT NULL,
        price_paise BIGINT NOT NULL,
        total_value_paise BIGINT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `,
  },
  {
    id: 4,
    name: "create_watchlist_table",
    sql: `
      CREATE TABLE IF NOT EXISTS watchlist (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        symbol VARCHAR(20) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, symbol)
      )
    `,
  },
  {
    id: 5,
    name: "add_google_auth_to_users",
    sql: `
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN google_id VARCHAR(255) UNIQUE;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE users ADD COLUMN name VARCHAR(255);
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
      EXCEPTION WHEN others THEN NULL; END $$;
    `,
  },
  {
    id: 6,
    name: "add_brokerage_to_orders",
    sql: `
      DO $$ BEGIN
        ALTER TABLE orders ADD COLUMN brokerage_paise BIGINT NOT NULL DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `,
  },
  {
    id: 7,
    name: "add_intraday_delivery_to_portfolio",
    sql: `
      DO $$ BEGIN
        ALTER TABLE portfolio ADD COLUMN order_mode VARCHAR(10) NOT NULL DEFAULT 'DELIVERY';
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE portfolio ADD COLUMN margin_used_paise BIGINT NOT NULL DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE portfolio ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      ALTER TABLE portfolio DROP CONSTRAINT IF EXISTS portfolio_user_id_symbol_key;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'portfolio_user_id_symbol_mode_key'
        ) THEN
          ALTER TABLE portfolio ADD CONSTRAINT portfolio_user_id_symbol_mode_key
            UNIQUE(user_id, symbol, order_mode);
        END IF;
      END $$;
    `,
  },
  {
    id: 8,
    name: "add_order_mode_to_orders",
    sql: `
      DO $$ BEGIN
        ALTER TABLE orders ADD COLUMN order_mode VARCHAR(10) NOT NULL DEFAULT 'INTRADAY';
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `,
  },
];

export async function runMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query("SELECT id FROM schema_migrations ORDER BY id");
  const applied = new Set(rows.map((r) => r.id));

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    await pool.query(migration.sql);
    await pool.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [
      migration.id,
      migration.name,
    ]);
    logger.info("Migration", `Applied ${migration.id}: ${migration.name}`);
  }
}
