-- M5: instrument registry + trading calendars.
-- Every cognitive record from M7 onward keys on instruments.id (UUID).
-- Options/futures land as ROWS later: underlying_id/expiry/strike/option_type
-- ship now, null for cash instruments — no schema work when derivatives arrive.
CREATE TABLE IF NOT EXISTS instruments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue VARCHAR(16) NOT NULL,
  symbol VARCHAR(32) NOT NULL,
  name VARCHAR(128) NOT NULL,
  asset_class VARCHAR(16) NOT NULL
    CHECK (asset_class IN ('equity','index','fx','crypto','commodity','option','future','etf')),
  currency CHAR(3) NOT NULL,
  tick_size NUMERIC(18,8),
  lot_size INTEGER,
  underlying_id UUID REFERENCES instruments(id),
  expiry DATE,
  strike NUMERIC(18,8),
  option_type VARCHAR(4) CHECK (option_type IN ('CALL','PUT')),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (venue, symbol)
);

CREATE INDEX IF NOT EXISTS idx_instruments_symbol ON instruments (symbol);

-- Per-venue calendar. Convention: a (venue, cal_date) row exists only for
-- EXCEPTIONS (holidays, special sessions); absent weekday = regular session,
-- weekends closed. Session times are venue-local wall clock.
CREATE TABLE IF NOT EXISTS trading_calendars (
  venue VARCHAR(16) NOT NULL,
  cal_date DATE NOT NULL,
  is_holiday BOOLEAN NOT NULL DEFAULT TRUE,
  session_open TIME,
  session_close TIME,
  label VARCHAR(64),
  PRIMARY KEY (venue, cal_date)
);
