-- A decision needs its own identity, separate from the thread it belongs to.
--
-- decision_records keyed idempotency on correlation_id. That is right for the
-- candidate route, which mints one id per decision, and wrong for the position
-- route: every reassessment of a position carries the THESIS's correlation id,
-- which is stable for the life of the position. With ON CONFLICT DO NOTHING the
-- first decision was stored and every later one on that position was silently
-- discarded, which is most of what a position does.
--
-- So: correlation_id goes back to being what its name says, the thread that
-- ties a position's decisions together, and decision_id becomes the identity a
-- retry collides on.

ALTER TABLE decision_records ADD COLUMN IF NOT EXISTS decision_id VARCHAR(64);

-- Existing rows were one-per-correlation by construction, so the correlation is
-- their decision identity.
UPDATE decision_records SET decision_id = correlation_id WHERE decision_id IS NULL;

ALTER TABLE decision_records ALTER COLUMN decision_id SET NOT NULL;

DROP INDEX IF EXISTS idx_decision_records_correlation;

CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_records_decision
  ON decision_records (decision_id);

-- Still indexed, just no longer unique: reading a position's whole decision
-- thread is the query this table exists to answer.
CREATE INDEX IF NOT EXISTS idx_decision_records_correlation
  ON decision_records (correlation_id, decided_at DESC);
