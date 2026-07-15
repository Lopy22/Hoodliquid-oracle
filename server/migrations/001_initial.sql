CREATE TABLE IF NOT EXISTS markets (
  market_id text PRIMARY KEY,
  symbol text NOT NULL,
  display_name text NOT NULL,
  market_type text NOT NULL CHECK (market_type IN ('CARDS','INDEX')),
  live boolean NOT NULL DEFAULT true,
  price_floor numeric(78,0) NOT NULL CHECK (price_floor > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_observations (
  market_id text NOT NULL,
  source text NOT NULL,
  raw_price numeric(78,0) NOT NULL CHECK (raw_price > 0),
  observed_at timestamptz NOT NULL,
  source_hash text NOT NULL,
  accepted boolean NOT NULL,
  rejection_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_hash, observed_at)
) PARTITION BY RANGE (observed_at);

CREATE INDEX IF NOT EXISTS source_observations_market_time_idx
  ON source_observations(market_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS source_state (
  source text PRIMARY KEY,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oracle_marks (
  market_id text PRIMARY KEY REFERENCES markets(market_id) ON DELETE CASCADE,
  price numeric(78,0) NOT NULL CHECK (price > 0),
  confidence_bps integer NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  observed_at timestamptz NOT NULL,
  source text NOT NULL,
  source_hash text NOT NULL,
  source_count integer NOT NULL CHECK (source_count > 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS oracle_mark_history (
  market_id text NOT NULL,
  price numeric(78,0) NOT NULL CHECK (price > 0),
  confidence_bps integer NOT NULL CHECK (confidence_bps BETWEEN 0 AND 10000),
  observed_at timestamptz NOT NULL,
  source text NOT NULL,
  source_hash text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market_id, observed_at, source_hash)
) PARTITION BY RANGE (observed_at);

CREATE INDEX IF NOT EXISTS oracle_mark_history_market_time_idx
  ON oracle_mark_history(market_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS candles (
  market_id text NOT NULL REFERENCES markets(market_id) ON DELETE CASCADE,
  bucket timestamptz NOT NULL,
  interval_seconds integer NOT NULL CHECK (interval_seconds IN (60,3600,86400)),
  open numeric(78,0) NOT NULL,
  high numeric(78,0) NOT NULL,
  low numeric(78,0) NOT NULL,
  close numeric(78,0) NOT NULL,
  observations integer NOT NULL CHECK (observations > 0),
  PRIMARY KEY (market_id, interval_seconds, bucket)
);

CREATE TABLE IF NOT EXISTS worker_leases (
  worker text PRIMARY KEY,
  holder text NOT NULL,
  heartbeat_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS worker_runs (
  id bigserial PRIMARY KEY,
  worker text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  success boolean,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS worker_runs_worker_time_idx
  ON worker_runs(worker, started_at DESC);

CREATE OR REPLACE FUNCTION ensure_month_partition(
  parent_table text,
  month_start date
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  partition_name text;
  month_end date;
BEGIN
  IF parent_table NOT IN ('source_observations','oracle_mark_history') THEN
    RAISE EXCEPTION 'unsupported partition parent: %', parent_table;
  END IF;
  month_start := date_trunc('month', month_start)::date;
  month_end := (month_start + interval '1 month')::date;
  partition_name := parent_table || '_' || to_char(month_start, 'YYYY_MM');
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
    partition_name,
    parent_table,
    month_start,
    month_end
  );
END;
$$;

SELECT ensure_month_partition('source_observations', date_trunc('month', now())::date);
SELECT ensure_month_partition('source_observations', (date_trunc('month', now()) + interval '1 month')::date);
SELECT ensure_month_partition('oracle_mark_history', date_trunc('month', now())::date);
SELECT ensure_month_partition('oracle_mark_history', (date_trunc('month', now()) + interval '1 month')::date);
