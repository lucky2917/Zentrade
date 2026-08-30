-- M18b: idempotency for autonomous orders.
--
-- The loop can legitimately re-derive the same intent (a persistent condition,
-- a retry, a restart mid-cycle). Deduplicating in application code would be a
-- race; a unique index makes a second insert of the same decision physically
-- impossible.
--
-- Nullable and partial: every existing human-placed order has no client id and
-- must stay unaffected.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_order_id VARCHAR(128);

CREATE UNIQUE INDEX IF NOT EXISTS orders_client_order_id_key
  ON orders (client_order_id) WHERE client_order_id IS NOT NULL;

-- Links an autonomous order back to the reassessment that produced it, so a
-- fill can be traced to the reasoning and the event that triggered it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(64);
CREATE INDEX IF NOT EXISTS orders_correlation_idx
  ON orders (correlation_id) WHERE correlation_id IS NOT NULL;
