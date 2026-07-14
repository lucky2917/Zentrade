-- M4: transactional outbox for the event backbone.
-- State change + event enqueue commit atomically; the relay publishes to
-- Redis Streams and stamps published_at (at-least-once; consumers dedupe
-- on the envelope's event_id).
CREATE TABLE IF NOT EXISTS outbox (
  id BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  event_type VARCHAR(128) NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ
);

-- the relay's working set: only unpublished rows, in insertion order
CREATE INDEX IF NOT EXISTS idx_outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
