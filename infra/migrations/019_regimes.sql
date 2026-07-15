-- M12: daily regime labels. The primary key (venue, cal_date, taxonomy)
-- plus append-only triggers make silent relabeling impossible: a revised
-- taxonomy coexists under a new taxonomy id, history stays intact forever.

CREATE TABLE IF NOT EXISTS regimes (
  venue VARCHAR(16) NOT NULL,
  cal_date DATE NOT NULL,
  taxonomy VARCHAR(32) NOT NULL,
  trend VARCHAR(16) NOT NULL,
  vol_bucket VARCHAR(16) NOT NULL,
  breadth VARCHAR(16),
  composite VARCHAR(48) NOT NULL,
  realized_vol_pct NUMERIC(8,2),
  inputs_hash CHAR(64) NOT NULL,
  labeled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (venue, cal_date, taxonomy)
);

CREATE INDEX IF NOT EXISTS idx_regimes_latest ON regimes (venue, taxonomy, cal_date DESC);

DO $$ BEGIN
  CREATE TRIGGER regimes_append_only
    BEFORE UPDATE OR DELETE ON regimes
    FOR EACH ROW EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER regimes_no_truncate
    BEFORE TRUNCATE ON regimes
    FOR EACH STATEMENT EXECUTE FUNCTION journal_forbid_mutation();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
