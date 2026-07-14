import { readdir, readFile } from "node:fs/promises";
import logger from "../utils/logger.js";

// M4 onward: new migrations live as SQL files in infra/migrations/NNN_name.sql
// (repo root). The in-code list below is frozen at id 12 — do not append here.
const SQL_MIGRATIONS_DIR = new URL("../../../../infra/migrations/", import.meta.url);

async function loadSqlMigrations() {
  let entries;
  try {
    entries = await readdir(SQL_MIGRATIONS_DIR);
  } catch (err) {
    // deployments always ship the directory; failing loud beats silently
    // skipping schema changes
    throw new Error(`infra/migrations directory not readable: ${err.message}`);
  }

  const out = [];
  for (const file of entries) {
    const match = /^(\d{3})_([a-z0-9_]+)\.sql$/.exec(file);
    if (!match) continue;
    const id = Number(match[1]);
    const sql = await readFile(new URL(file, SQL_MIGRATIONS_DIR), "utf8");
    out.push({ id, name: match[2], sql });
  }
  return out;
}

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
  {
    id: 9,
    name: "add_hot_path_indexes",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_portfolio_user_id ON portfolio(user_id);
      CREATE INDEX IF NOT EXISTS idx_orders_user_id_id ON orders(user_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_watchlist_user_id ON watchlist(user_id);
    `,
  },
  {
    id: 10,
    name: "add_pnl_paise_to_orders",
    sql: `
      DO $$ BEGIN
        ALTER TABLE orders ADD COLUMN pnl_paise BIGINT DEFAULT NULL;
      EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `,
  },
  {
    id: 11,
    name: "add_cascade_and_check_constraints",
    sql: `
      -- ON DELETE CASCADE so deleting a user cleans up their data
      ALTER TABLE portfolio DROP CONSTRAINT IF EXISTS portfolio_user_id_fkey;
      ALTER TABLE portfolio ADD CONSTRAINT portfolio_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

      ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_user_id_fkey;
      ALTER TABLE orders ADD CONSTRAINT orders_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

      ALTER TABLE watchlist DROP CONSTRAINT IF EXISTS watchlist_user_id_fkey;
      ALTER TABLE watchlist ADD CONSTRAINT watchlist_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

      -- Portfolio quantity must be positive (zero rows are deleted on full sell)
      DO $$ BEGIN
        ALTER TABLE portfolio ADD CONSTRAINT portfolio_quantity_check CHECK (quantity > 0);
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `,
  },
  {
    id: 12,
    name: "normalise_email_case",
    sql: `
      -- Lowercase existing emails; skip any that would collide with an
      -- already-lowercase duplicate (those need manual account merging)
      UPDATE users SET email = LOWER(email)
      WHERE email <> LOWER(email)
        AND NOT EXISTS (SELECT 1 FROM users u2 WHERE u2.email = LOWER(users.email));
    `,
  },
];

// arbitrary app-unique key for the migration advisory lock
const MIGRATION_LOCK_KEY = 727001;

export async function runMigrations(pool) {
  // Advisory lock serializes concurrent migrators (parallel test workers
  // today, multi-instance deploys tomorrow). Session-scoped, so everything
  // must run on one dedicated connection.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    const { rows } = await client.query("SELECT id FROM schema_migrations ORDER BY id");
    const applied = new Set(rows.map((r) => r.id));

    const sqlMigrations = await loadSqlMigrations();
    const all = [...migrations, ...sqlMigrations].sort((a, b) => a.id - b.id);
    const ids = all.map((m) => m.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(`duplicate migration ids detected: ${ids.join(",")}`);
    }

    for (const migration of all) {
      if (applied.has(migration.id)) continue;
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (id, name) VALUES ($1, $2)", [
        migration.id,
        migration.name,
      ]);
      logger.info("Migration", `Applied ${migration.id}: ${migration.name}`);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}
