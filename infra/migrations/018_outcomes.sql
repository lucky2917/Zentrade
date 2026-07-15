-- M11: realized outcomes — historical facts derived deterministically from
-- post-decision candles. Append-only like the journal it grades.
-- UNIQUE(decision_id, horizon) is the idempotency law: one fact per horizon.

CREATE TABLE IF NOT EXISTS outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id UUID NOT NULL REFERENCES decisions(id),
  horizon VARCHAR(16) NOT NULL,
  basis VARCHAR(16) NOT NULL CHECK (basis IN ('path','close','squareoff','abstain')),
  hit VARCHAR(16) NOT NULL CHECK (hit IN ('target','stop','neither')),
  entry_minor BIGINT,
  exit_minor BIGINT,
  realized_return_bps INTEGER,
  sessions_used INTEGER NOT NULL CHECK (sessions_used >= 0),
  data_source VARCHAR(64) NOT NULL,
  labeled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (decision_id, horizon)
);

CREATE INDEX IF NOT EXISTS idx_outcomes_decision ON outcomes (decision_id);

DO $$ BEGIN
  CREATE TRIGGER outcomes_append_only
    BEFORE UPDATE OR DELETE ON outcomes
    FOR EACH ROW EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER outcomes_no_truncate
    BEFORE TRUNCATE ON outcomes
    FOR EACH STATEMENT EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
