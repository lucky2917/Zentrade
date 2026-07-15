-- M8: the Evidence Chain.
-- Evidence rows are immutable OBSERVATIONS attached to the decision request
-- (the bundle every agent saw, stored once). Agent runs cite them by stable
-- in-bundle refs inside their validated outputs — interpretation never mixes
-- with observation. (Deliberate refinement over the shorthand agent_run_id
-- column: see M8 compliance report.)

CREATE TABLE IF NOT EXISTS evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES decision_requests(id),
  ref VARCHAR(64) NOT NULL,
  kind VARCHAR(16) NOT NULL
    CHECK (kind IN ('price','indicator','intraday','macro','news','memory','knowledge','analog')),
  source_ref TEXT NOT NULL,
  content JSONB NOT NULL,
  weight NUMERIC(6,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, ref)
);

CREATE INDEX IF NOT EXISTS idx_evidence_request ON evidence (request_id);
CREATE INDEX IF NOT EXISTS idx_evidence_kind ON evidence (kind);

-- evidence is as immutable as the journal itself
DO $$ BEGIN
  CREATE TRIGGER evidence_append_only
    BEFORE UPDATE OR DELETE ON evidence
    FOR EACH ROW EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER evidence_no_truncate
    BEFORE TRUNCATE ON evidence
    FOR EACH STATEMENT EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- M8 DoD as a database law: no decision may exist without evidence.
CREATE OR REPLACE FUNCTION decisions_require_evidence() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM evidence WHERE request_id = NEW.request_id) THEN
    RAISE EXCEPTION 'decision % rejected: no evidence rows exist for request %', NEW.id, NEW.request_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER decisions_require_evidence
    BEFORE INSERT ON decisions
    FOR EACH ROW EXECUTE FUNCTION decisions_require_evidence();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- the validator's verdict is itself historical evidence: stored, not recomputed
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS citation_report JSONB;
