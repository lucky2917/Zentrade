-- M7: the Decision Journal — permanent historical evidence of every AI run.
-- Constitutional properties enforced here:
--   * instrument identity by FK (M5 rule), never bare symbol strings
--   * append-only: UPDATE/DELETE rejected by trigger on all three tables
--   * lineage: request -> agent_runs -> decision, correlation ids throughout

CREATE TABLE IF NOT EXISTS decision_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id UUID NOT NULL REFERENCES instruments(id),
  requested_by VARCHAR(32) NOT NULL,
  correlation_id UUID NOT NULL,
  context_snapshot JSONB NOT NULL,
  regime JSONB NOT NULL DEFAULT '{"taxonomy":"none","label":"unlabeled"}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES decision_requests(id),
  agent_name VARCHAR(64) NOT NULL,
  agent_version VARCHAR(32) NOT NULL,
  model_id VARCHAR(128) NOT NULL,
  input_hash CHAR(64) NOT NULL,
  output JSONB NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','failed','invalid')),
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cost_usd NUMERIC(10,6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL UNIQUE REFERENCES decision_requests(id),
  instrument_id UUID NOT NULL REFERENCES instruments(id),
  action VARCHAR(8) NOT NULL CHECK (action IN ('BUY','SELL','HOLD')),
  mode VARCHAR(10) NOT NULL CHECK (mode IN ('INTRADAY','DELIVERY')),
  confidence VARCHAR(8) NOT NULL CHECK (confidence IN ('HIGH','MEDIUM','LOW')),
  entry_minor BIGINT,
  target_minor BIGINT,
  stop_minor BIGINT,
  rationale JSONB NOT NULL,
  synthesizer_version VARCHAR(32) NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_decision_requests_instrument ON decision_requests (instrument_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_request ON agent_runs (request_id);
CREATE INDEX IF NOT EXISTS idx_decisions_instrument ON decisions (instrument_id, created_at DESC);

-- Append-only enforcement. We run as table owner on managed Postgres, so
-- GRANT-based protection cannot bind us; triggers are the strongest
-- in-database guarantee available. (An owner could drop the trigger — that
-- residual risk is recorded in PROJECT_STATE.)
CREATE OR REPLACE FUNCTION journal_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'journal is append-only: % on % is forbidden', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER decision_requests_append_only
    BEFORE UPDATE OR DELETE ON decision_requests
    FOR EACH ROW EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER agent_runs_append_only
    BEFORE UPDATE OR DELETE ON agent_runs
    FOR EACH ROW EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER decisions_append_only
    BEFORE UPDATE OR DELETE ON decisions
    FOR EACH ROW EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- TRUNCATE bypasses row-level triggers — block it explicitly. Immutability
-- outranks test convenience (tests use throwaway databases and delta counts).
DO $$ BEGIN
  CREATE TRIGGER decision_requests_no_truncate
    BEFORE TRUNCATE ON decision_requests
    FOR EACH STATEMENT EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER agent_runs_no_truncate
    BEFORE TRUNCATE ON agent_runs
    FOR EACH STATEMENT EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER decisions_no_truncate
    BEFORE TRUNCATE ON decisions
    FOR EACH STATEMENT EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
