-- M14: episodic memory — an INDEX over experience, not another database.
-- Rows hold journal references and deterministic retrieval keys only;
-- anything authoritative lives in the journal and is reached by join.
-- memory_key is the stable identity: hash of (scope, decision_id, horizon),
-- independent of embedding models, narrative templates, and feature schemas.
-- Append-only like everything the brain remembers.

CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_key CHAR(64) NOT NULL UNIQUE,
  semantics VARCHAR(32) NOT NULL,
  decision_id UUID NOT NULL REFERENCES decisions(id),
  request_id UUID NOT NULL REFERENCES decision_requests(id),
  outcome_id UUID NOT NULL REFERENCES outcomes(id),
  instrument_id UUID NOT NULL REFERENCES instruments(id),
  horizon VARCHAR(16) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  venue VARCHAR(16) NOT NULL,
  action VARCHAR(8) NOT NULL,
  mode VARCHAR(16) NOT NULL,
  confidence VARCHAR(8) NOT NULL,
  regime VARCHAR(48) NOT NULL,
  hit VARCHAR(16) NOT NULL,
  basis VARCHAR(16) NOT NULL,
  realized_return_bps INTEGER,
  decision_date DATE NOT NULL,
  formed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (decision_id, horizon)
);

CREATE INDEX IF NOT EXISTS idx_memories_symbol_date ON memories (symbol, decision_date DESC);
CREATE INDEX IF NOT EXISTS idx_memories_regime_action ON memories (regime, action);
CREATE INDEX IF NOT EXISTS idx_memories_hit ON memories (hit);

DO $$ BEGIN
  CREATE TRIGGER memories_append_only
    BEFORE UPDATE OR DELETE ON memories
    FOR EACH ROW EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER memories_no_truncate
    BEFORE TRUNCATE ON memories
    FOR EACH STATEMENT EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
