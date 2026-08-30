-- Events had identity but no lifecycle.
--
-- event_key is UNIQUE for the life of the database and recordEvent used
-- ON CONFLICT DO NOTHING, so once a condition was written it could never be
-- offered to reasoning again. Combined with an in-memory queue that dropped on
-- capacity and expired after 60 seconds, a critical condition could be raised,
-- dropped, and then silently swallowed on every later re-emission.
--
-- handled_at existed and had an index built for it. Nothing ever wrote it, so
-- there was no way to tell a condition that had been reasoned about from one
-- that had not, and a restart could not recover pending work.

ALTER TABLE position_events ADD COLUMN IF NOT EXISTS state VARCHAR(12) NOT NULL DEFAULT 'PENDING';
ALTER TABLE position_events ADD COLUMN IF NOT EXISTS leased_until TIMESTAMPTZ;
ALTER TABLE position_events ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE position_events ADD COLUMN IF NOT EXISTS last_error TEXT;

-- Rows written before this migration were never tracked; treat them as done
-- rather than resurrecting a backlog of history on first boot.
UPDATE position_events SET state = 'HANDLED', handled_at = COALESCE(handled_at, created_at)
WHERE state = 'PENDING' AND created_at < NOW() - INTERVAL '1 day';

DO $$ BEGIN
  ALTER TABLE position_events ADD CONSTRAINT position_events_state_valid
    CHECK (state IN ('PENDING','LEASED','HANDLED','ABANDONED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A handled event must record when. An unhandled one must not pretend it was.
DO $$ BEGIN
  ALTER TABLE position_events ADD CONSTRAINT position_events_handled_consistent
    CHECK ((state = 'HANDLED') = (handled_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The queue is a projection of this index: unhandled work, worst first, oldest
-- first within a severity.
CREATE INDEX IF NOT EXISTS position_events_pending_idx
  ON position_events (user_id, severity, observed_at)
  WHERE state IN ('PENDING','LEASED');

CREATE INDEX IF NOT EXISTS position_events_lease_idx
  ON position_events (leased_until) WHERE state = 'LEASED';
