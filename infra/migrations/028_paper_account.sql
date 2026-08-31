-- One continuous paper-trading account whose state survives restarts, crashes
-- and trading days.
--
-- Cash, positions, orders, fills, theses, reassessments and market events were
-- already durable. Three things were not, and without them the account had no
-- identity across days:
--
--   · what it started with, so profit and loss can be stated against it
--   · the reasoning behind every decision, which lived only in the cockpit's
--     in-memory ring and died with the process
--   · a per-session record, so a day can be reviewed after it ends
--
-- Nothing here ever resets. The account is opened once and continues.

CREATE TABLE IF NOT EXISTS paper_account (
  user_id            INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  -- The reference the whole account is measured against. Written once at
  -- opening and never updated; a starting capital that moves makes every P&L
  -- figure derived from it meaningless.
  starting_capital_paise BIGINT NOT NULL CHECK (starting_capital_paise > 0),
  -- P&L the account had already realised into its cash before this record
  -- existed, when exits booked cash without writing pnl_paise onto the order.
  -- It is not attributable to any order any more, so it is stated once, at
  -- opening, rather than pretended away. Zero for an account opened fresh.
  opening_adjustment_paise BIGINT NOT NULL DEFAULT 0,
  currency           VARCHAR(3) NOT NULL DEFAULT 'INR',
  opened_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Paper only. A column rather than a comment so a live-money row would have
  -- to be written deliberately, and the CHECK refuses one.
  mode               VARCHAR(8) NOT NULL DEFAULT 'PAPER' CHECK (mode = 'PAPER')
);

-- The auditable reasoning record: one row per decision the brain reached,
-- executed or not. Structured artifacts the system already produces — never
-- hidden model reasoning, which the pipeline does not expose and this does not
-- store.
CREATE TABLE IF NOT EXISTS decision_records (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  correlation_id     VARCHAR(64) NOT NULL,
  session_date       DATE NOT NULL,
  symbol             VARCHAR(32) NOT NULL,
  route              VARCHAR(16) NOT NULL,
  -- What woke the brain.
  trigger_type       VARCHAR(48),
  trigger_severity   VARCHAR(16),
  trigger_reason     TEXT,
  -- What it concluded.
  action             VARCHAR(16) NOT NULL,
  confidence         VARCHAR(16),
  -- The artifacts, each stored as given rather than summarised.
  evidence           JSONB NOT NULL DEFAULT '[]'::jsonb,
  thesis             TEXT,
  supporting         JSONB NOT NULL DEFAULT '[]'::jsonb,
  contradicting      JSONB NOT NULL DEFAULT '[]'::jsonb,
  counter_thesis     TEXT,
  alternatives       JSONB NOT NULL DEFAULT '[]'::jsonb,
  what_would_change  JSONB NOT NULL DEFAULT '[]'::jsonb,
  challenge_verdict  VARCHAR(24),
  synthesis          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- What the deterministic layers decided.
  risk_decision      VARCHAR(16),
  risk_code          VARCHAR(48),
  risk_reason        TEXT,
  executed           BOOLEAN NOT NULL DEFAULT FALSE,
  blocked_reason     TEXT,
  -- The thesis this decision produced, when it produced one. SET NULL rather
  -- than CASCADE: the decision record is the audit trail and must outlive the
  -- thesis, and must not block its removal either.
  thesis_id          UUID REFERENCES trade_thesis(id) ON DELETE SET NULL,
  -- Money at the moment of the decision.
  price_paise        BIGINT,
  quantity           INTEGER,
  decided_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decision_records_session
  ON decision_records (user_id, session_date DESC, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_records_symbol
  ON decision_records (user_id, symbol, decided_at DESC);
-- The correlation id IS the decision's identity: one is minted per decision
-- instant, so a retried or replayed write lands on the same row instead of a
-- second one. Any future writer must mint one per decision rather than reuse a
-- position's, or its later decisions will be silently dropped here.
CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_records_correlation
  ON decision_records (correlation_id);

-- One row per trading day, so a session can be reviewed after it closes and
-- the equity curve has a durable series behind it.
CREATE TABLE IF NOT EXISTS session_summaries (
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_date       DATE NOT NULL,
  opening_cash_paise BIGINT NOT NULL,
  closing_cash_paise BIGINT NOT NULL,
  opening_equity_paise BIGINT,
  closing_equity_paise BIGINT,
  realised_pnl_paise BIGINT NOT NULL DEFAULT 0,
  unrealised_pnl_paise BIGINT NOT NULL DEFAULT 0,
  costs_paise        BIGINT NOT NULL DEFAULT 0,
  orders_placed      INTEGER NOT NULL DEFAULT 0,
  positions_opened   INTEGER NOT NULL DEFAULT 0,
  positions_closed   INTEGER NOT NULL DEFAULT 0,
  decisions_made     INTEGER NOT NULL DEFAULT 0,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, session_date)
);

-- Durable runtime events: starts, stops, recoveries and failures, so a restart
-- or a crash is visible after the fact rather than only in a log file.
CREATE TABLE IF NOT EXISTS agent_events (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_date       DATE NOT NULL,
  kind               VARCHAR(32) NOT NULL,
  detail             JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_events_session
  ON agent_events (user_id, session_date DESC, occurred_at DESC);
