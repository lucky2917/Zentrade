-- M13: calibration snapshots — append-only derived aggregates. Each recompute
-- INSERTS a new snapshot; reads take the latest. The history of what the
-- system believed about its own skill is itself permanent evidence.
-- Measurement only: nothing reads these tables to influence decisions.

CREATE TABLE IF NOT EXISTS calibration_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of DATE NOT NULL,
  semantics VARCHAR(32) NOT NULL,
  sample_count INTEGER NOT NULL CHECK (sample_count >= 0),
  cell_count INTEGER NOT NULL CHECK (cell_count >= 0),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS calibration_cells (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES calibration_snapshots(id),
  agent_name VARCHAR(64) NOT NULL,
  agent_version VARCHAR(32) NOT NULL,
  regime VARCHAR(48) NOT NULL,
  horizon VARCHAR(16) NOT NULL,
  n INTEGER NOT NULL CHECK (n >= 0),
  n_effective NUMERIC(10,2) NOT NULL CHECK (n_effective >= 0),
  sufficient BOOLEAN NOT NULL,
  brier NUMERIC(8,6) CHECK (brier >= 0 AND brier <= 1),
  hit_rate NUMERIC(6,4) CHECK (hit_rate >= 0 AND hit_rate <= 1),
  UNIQUE (snapshot_id, agent_name, agent_version, regime, horizon),
  CHECK (sufficient OR (brier IS NULL AND hit_rate IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_calibration_snapshots_latest
  ON calibration_snapshots (computed_at DESC);

DO $$ BEGIN
  CREATE TRIGGER calibration_snapshots_append_only
    BEFORE UPDATE OR DELETE ON calibration_snapshots
    FOR EACH ROW EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER calibration_snapshots_no_truncate
    BEFORE TRUNCATE ON calibration_snapshots
    FOR EACH STATEMENT EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER calibration_cells_append_only
    BEFORE UPDATE OR DELETE ON calibration_cells
    FOR EACH ROW EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER calibration_cells_no_truncate
    BEFORE TRUNCATE ON calibration_cells
    FOR EACH STATEMENT EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
