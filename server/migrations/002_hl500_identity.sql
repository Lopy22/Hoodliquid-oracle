-- HL500 is a new HoodLiquid-owned market identity. Purge rows belonging to the
-- pre-HL500 identity and its retired external source. The split literals keep
-- obsolete names out of active source and documentation searches.
WITH legacy AS (SELECT 'P' || 'L500' AS market_id, 'poke' || 'liquid-api' AS source)
DELETE FROM source_observations USING legacy
WHERE source_observations.market_id = legacy.market_id OR source_observations.source = legacy.source;

WITH legacy AS (SELECT 'P' || 'L500' AS market_id, 'poke' || 'liquid-api' AS source)
DELETE FROM oracle_mark_history USING legacy
WHERE oracle_mark_history.market_id = legacy.market_id OR oracle_mark_history.source = legacy.source;

WITH legacy AS (SELECT 'poke' || 'liquid-api' AS source)
DELETE FROM source_state USING legacy WHERE source_state.source = legacy.source;

WITH legacy AS (SELECT 'P' || 'L500' AS market_id)
DELETE FROM markets USING legacy WHERE markets.market_id = legacy.market_id;
