-- M9: link trades to the decisions that motivated them, and support
-- keyset pagination over the (append-only) decisions stream.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS decision_id UUID REFERENCES decisions(id);

CREATE INDEX IF NOT EXISTS idx_orders_decision ON orders (decision_id) WHERE decision_id IS NOT NULL;

-- global keyset listing: ORDER BY created_at DESC, id DESC
CREATE INDEX IF NOT EXISTS idx_decisions_keyset ON decisions (created_at DESC, id DESC);
