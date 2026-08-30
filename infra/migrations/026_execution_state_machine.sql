-- M19: the production execution state machine.
--
-- `orders` becomes the canonical ORDER LIFECYCLE record rather than a
-- completed-trade record. Every pre-existing row describes a trade that was
-- submitted and filled in one transaction, so it backfills exactly to
-- state=FILLED with filled_quantity = quantity. No history is reinterpreted
-- and no competing order table is introduced.
--
-- Fills move to their own table. A fill is a fact about an execution; an order
-- is the intent and its lifecycle. Collapsing them is what made partial fills
-- unrepresentable.
--
-- Cash model:
--   users.balance_paise      total settled cash; changes only on a fill
--   orders.reserved_paise    cash held against this order's REMAINING obligation
--   available                balance - SUM(reserved_paise) over non-terminal orders
-- A terminal order must hold zero reservation. That is enforced by CHECK, not
-- by convention.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS state VARCHAR(20);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS filled_quantity INTEGER;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reserved_paise BIGINT NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS limit_price_paise BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reference_price_paise BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type VARCHAR(12) NOT NULL DEFAULT 'MARKET';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS working_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS last_update_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS thesis_id UUID REFERENCES trade_thesis(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS risk_decision VARCHAR(12);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(160);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ambiguity_reason VARCHAR(160);

-- Backfill before constraining: legacy rows are completed trades.
UPDATE orders SET state = 'FILLED' WHERE state IS NULL;
UPDATE orders SET filled_quantity = quantity WHERE filled_quantity IS NULL;
UPDATE orders SET last_update_at = created_at WHERE last_update_at IS NULL;
UPDATE orders SET completed_at = created_at WHERE completed_at IS NULL AND state = 'FILLED';

ALTER TABLE orders ALTER COLUMN state SET NOT NULL;
ALTER TABLE orders ALTER COLUMN filled_quantity SET NOT NULL;
ALTER TABLE orders ALTER COLUMN filled_quantity SET DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_state_valid CHECK (state IN
    ('NEW','ACCEPTED','WORKING','PARTIALLY_FILLED','FILLED','CANCELLED','EXPIRED','REJECTED','AMBIGUOUS'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- No overfill, ever. The database refuses it regardless of application logic.
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_no_overfill
    CHECK (filled_quantity >= 0 AND filled_quantity <= quantity);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_reservation_non_negative
    CHECK (reserved_paise >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A terminal order holds no reservation, and a fully filled order is FILLED.
DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_terminal_holds_no_reservation CHECK (
    state NOT IN ('FILLED','CANCELLED','EXPIRED','REJECTED') OR reserved_paise = 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_filled_state_consistent CHECK (
    (state = 'FILLED' AND filled_quantity = quantity)
    OR (state <> 'FILLED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS orders_open_idx ON orders (user_id, symbol)
  WHERE state IN ('NEW','ACCEPTED','WORKING','PARTIALLY_FILLED','AMBIGUOUS');
CREATE INDEX IF NOT EXISTS orders_expiry_idx ON orders (expires_at)
  WHERE state IN ('ACCEPTED','WORKING','PARTIALLY_FILLED');

-- One row per execution. Identity is (order_id, execution_ref) so a repeated
-- broker callback cannot be inserted twice.
CREATE TABLE IF NOT EXISTS order_fills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  execution_ref VARCHAR(128) NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  side VARCHAR(4) NOT NULL CHECK (side IN ('BUY','SELL')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  price_paise BIGINT NOT NULL CHECK (price_paise > 0),
  brokerage_paise BIGINT NOT NULL DEFAULT 0,
  correlation_id VARCHAR(64),
  source VARCHAR(24) NOT NULL DEFAULT 'paper',
  filled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, execution_ref)
);

CREATE INDEX IF NOT EXISTS order_fills_order_idx ON order_fills (order_id);

-- Backfill one fill per legacy order so the invariant
-- sum(fills.quantity) = orders.filled_quantity holds for every row, not just
-- new ones. This states the same fact in the new model rather than inventing
-- information: the trade did fill fully, at that price, in one execution.
INSERT INTO order_fills (order_id, execution_ref, symbol, side, quantity,
                         price_paise, brokerage_paise, correlation_id, source, filled_at)
SELECT o.id, 'legacy-' || o.id, o.symbol, o.type, o.quantity,
       o.price_paise, o.brokerage_paise, o.correlation_id, 'legacy', o.created_at
FROM orders o
WHERE o.state = 'FILLED'
  AND NOT EXISTS (SELECT 1 FROM order_fills f WHERE f.order_id = o.id);

-- Reconciliation attempts, kept as evidence rather than overwritten.
CREATE TABLE IF NOT EXISTS order_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id INTEGER NOT NULL REFERENCES orders(id),
  outcome VARCHAR(12) NOT NULL CHECK (outcome IN ('MATCHED','MISMATCH','AMBIGUOUS')),
  internal_state VARCHAR(20) NOT NULL,
  external_state VARCHAR(20),
  internal_filled INTEGER NOT NULL,
  external_filled INTEGER,
  detail TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS order_reconciliations_order_idx
  ON order_reconciliations (order_id, created_at DESC);
