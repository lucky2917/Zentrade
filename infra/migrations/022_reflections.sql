-- M16: reflection snapshots — structured observations the system makes about
-- itself from calibration history and episodic memory. Facts with
-- references, never advice. Append-only like every other form of
-- self-knowledge; nothing on the decision path reads these tables.

CREATE TABLE IF NOT EXISTS reflection_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of DATE NOT NULL,
  semantics VARCHAR(32) NOT NULL,
  finding_count INTEGER NOT NULL CHECK (finding_count >= 0),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reflection_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_id UUID NOT NULL REFERENCES reflection_snapshots(id),
  kind VARCHAR(32) NOT NULL CHECK (kind IN
    ('calibration_drift', 'miscalibration', 'regime_weakness', 'regime_strength', 'contradiction')),
  severity VARCHAR(16) NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  subject VARCHAR(160) NOT NULL,
  detail JSONB NOT NULL,
  UNIQUE (snapshot_id, kind, subject)
);

CREATE INDEX IF NOT EXISTS idx_reflection_snapshots_latest
  ON reflection_snapshots (computed_at DESC);

DO $$ BEGIN
  CREATE TRIGGER reflection_snapshots_append_only
    BEFORE UPDATE OR DELETE ON reflection_snapshots
    FOR EACH ROW EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER reflection_snapshots_no_truncate
    BEFORE TRUNCATE ON reflection_snapshots
    FOR EACH STATEMENT EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER reflection_findings_append_only
    BEFORE UPDATE OR DELETE ON reflection_findings
    FOR EACH ROW EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER reflection_findings_no_truncate
    BEFORE TRUNCATE ON reflection_findings
    FOR EACH STATEMENT EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
