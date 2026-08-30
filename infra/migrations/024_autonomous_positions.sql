-- M18: the autonomous loop's position memory.
--
-- The canonical position is still `portfolio` (user_id, symbol, quantity,
-- avg_price_paise). Nothing here duplicates it. These tables record why a
-- position exists, what would make it wrong, and everything the monitor and
-- the reasoning path have observed about it since.
--
-- The entry thesis is IMMUTABLE. A reassessment is a new row that references
-- the thesis it re-examined; it never rewrites the original. Without that the
-- system cannot answer "what changed since we entered", which is the whole
-- point of position-aware reasoning.
--
-- All money is paise (integer minor units), matching `portfolio` and the
-- research spine. No floats anywhere on this path.

CREATE TABLE IF NOT EXISTS trade_thesis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id INTEGER NOT NULL REFERENCES users(id),
  symbol VARCHAR(20) NOT NULL,
  correlation_id VARCHAR(64) NOT NULL,

  side VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
  entry_price_paise BIGINT NOT NULL CHECK (entry_price_paise > 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),

  -- What must stay true. A thesis with no invalidation condition cannot be
  -- falsified, so the column is NOT NULL by design.
  rationale TEXT NOT NULL,
  setup_type VARCHAR(48) NOT NULL,
  invalidation_conditions JSONB NOT NULL,
  supporting_evidence JSONB NOT NULL,

  stop_paise BIGINT CHECK (stop_paise IS NULL OR stop_paise > 0),
  target_paise BIGINT CHECK (target_paise IS NULL OR target_paise > 0),
  horizon VARCHAR(24) NOT NULL,
  risk_note TEXT,

  market_regime VARCHAR(32),
  session_phase VARCHAR(24),

  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMPTZ,
  close_reason VARCHAR(48),

  UNIQUE (user_id, symbol, correlation_id)
);

CREATE INDEX IF NOT EXISTS trade_thesis_open_idx
  ON trade_thesis (user_id, symbol) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS trade_thesis_correlation_idx
  ON trade_thesis (correlation_id);

-- Append-only: a thesis is the record of what we believed at entry. Editing it
-- would let the system rewrite its own history and score itself favourably.
CREATE OR REPLACE FUNCTION trade_thesis_immutable() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.rationale IS DISTINCT FROM OLD.rationale
     OR NEW.invalidation_conditions IS DISTINCT FROM OLD.invalidation_conditions
     OR NEW.supporting_evidence IS DISTINCT FROM OLD.supporting_evidence
     OR NEW.entry_price_paise IS DISTINCT FROM OLD.entry_price_paise
     OR NEW.setup_type IS DISTINCT FROM OLD.setup_type
     OR NEW.side IS DISTINCT FROM OLD.side THEN
    RAISE EXCEPTION 'trade_thesis is immutable; only closed_at/close_reason may change';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trade_thesis_immutable_trg ON trade_thesis;
CREATE TRIGGER trade_thesis_immutable_trg
  BEFORE UPDATE ON trade_thesis
  FOR EACH ROW EXECUTE FUNCTION trade_thesis_immutable();

-- Events the monitor emitted. Deduplicated on event_key so a restart or a
-- repeated observation cannot trigger the same reasoning twice.
CREATE TABLE IF NOT EXISTS position_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key VARCHAR(128) NOT NULL UNIQUE,
  event_type VARCHAR(40) NOT NULL,
  severity VARCHAR(12) NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  symbol VARCHAR(20) NOT NULL,
  user_id INTEGER REFERENCES users(id),
  thesis_id UUID REFERENCES trade_thesis(id),
  correlation_id VARCHAR(64) NOT NULL,
  source VARCHAR(32) NOT NULL,
  observed JSONB NOT NULL,
  previous JSONB,
  reason TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  handled_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS position_events_unhandled_idx
  ON position_events (created_at) WHERE handled_at IS NULL;
CREATE INDEX IF NOT EXISTS position_events_symbol_idx
  ON position_events (symbol, created_at DESC);

-- Each AI reassessment, bound to the thesis it re-examined and the event that
-- triggered it. Append-only.
CREATE TABLE IF NOT EXISTS position_reassessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thesis_id UUID NOT NULL REFERENCES trade_thesis(id),
  event_id UUID REFERENCES position_events(id),
  correlation_id VARCHAR(64) NOT NULL,

  action VARCHAR(8) NOT NULL CHECK (action IN ('HOLD', 'REDUCE', 'EXIT', 'ADD')),
  confidence VARCHAR(8) NOT NULL CHECK (confidence IN ('HIGH', 'MEDIUM', 'LOW')),
  thesis_still_valid BOOLEAN NOT NULL,
  what_changed TEXT NOT NULL,
  material BOOLEAN NOT NULL,
  reasoning TEXT NOT NULL,
  evidence JSONB NOT NULL,

  unrealised_pnl_paise BIGINT NOT NULL,
  current_price_paise BIGINT NOT NULL,
  holding_seconds INTEGER NOT NULL,

  risk_decision VARCHAR(12) CHECK (risk_decision IN ('ALLOW', 'REJECT')),
  risk_reason TEXT,
  executed BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS position_reassessments_thesis_idx
  ON position_reassessments (thesis_id, created_at DESC);
