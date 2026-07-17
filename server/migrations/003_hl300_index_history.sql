-- Keep the latest accepted constituent observation available for HL300
-- carry-forward when a later source poll temporarily has no quote.
CREATE INDEX IF NOT EXISTS source_observations_market_observed_idx
ON source_observations (market_id, observed_at DESC)
WHERE accepted = true;
