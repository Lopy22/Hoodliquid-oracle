const crypto = require("node:crypto");
const { createDatabase, withTransaction } = require("../db.cjs");
const { logger } = require("../logger.cjs");
const { argument, runWorker } = require("./loop.cjs");
const { scrapeCycle } = require("../../scripts/scrape-tcgplayer-prices.cjs");
const { activeRegistryMarkets } = require("../../scripts/oracle-market-registry.cjs");

let lastRetentionAt = 0;

async function main() {
  const chainId = argument("chain-id") || process.env.CHAIN_ID;
  const { network, pool } = createDatabase(chainId);
  await syncMarkets(pool, network.chainId);
  try {
    await runWorker({
      pool,
      network,
      name: "market-data",
      intervalMs: Number(process.env.ORACLE_SCRAPE_INTERVAL_MS || 60_000),
      run: () => ingestCycle(pool)
    });
  } finally {
    await pool.end();
  }
}

async function ingestCycle(pool, chainIdOrScrape, scrapeOverride) {
  // Keep the public worker helper compatible with callers that previously
  // supplied (pool, chainId, scrape). Chain selection is now registry-driven.
  const scrape = typeof chainIdOrScrape === "function"
    ? chainIdOrScrape
    : scrapeOverride || scrapeCycle;
  const [marks, sourceState, constituentObservations] = await Promise.all([
    pool.query("SELECT market_id,metadata FROM oracle_marks"),
    pool.query("SELECT state FROM source_state WHERE source='poketrace'"),
    pool.query(
      `SELECT DISTINCT ON (market_id) market_id,metadata
       FROM source_observations
       WHERE accepted=true AND market_id LIKE 'HL500-%'
       ORDER BY market_id,observed_at DESC`
    )
  ]);
  const previousPrices = previousPriceMap(marks.rows, constituentObservations.rows);
  const result = await scrape({
    persist: false,
    quiet: process.env.ORACLE_VERBOSE !== "true",
    previousPayload: { prices: previousPrices },
    previousPoketrace: sourceState.rows[0]?.state
  });
  if (result.targetCount > 0 && result.successfulMarkets === 0) {
    throw new Error("all " + result.targetCount + " oracle targets failed");
  }

  const protocolMarketIds = new Set(activeRegistryMarkets().map((market) => market.priceApiMarket));
  await withTransaction(pool, async (client) => {
    await ensurePartitions(client);
    await enforceRetention(client);
    await client.query(
      "INSERT INTO source_state(source,state,updated_at) VALUES ('poketrace',$1,now()) "
      + "ON CONFLICT (source) DO UPDATE SET state=EXCLUDED.state,updated_at=now()",
      [result.poketracePayload]
    );

    for (const [marketId, quote] of Object.entries(result.payload.prices)) {
      const price = Math.round(Number(quote?.price || 0));
      const rawPrice = Math.round(Number(quote?.rawPrice || quote?.price || 0));
      const observedAtSeconds = Number(quote?.lastUpdateTime || 0);
      if (price <= 0 || rawPrice <= 0 || observedAtSeconds <= 0) continue;

      const observedAt = new Date(observedAtSeconds * 1_000);
      const source = String(quote.source || "unknown");
      const sourceHash = hashSource({
        marketId,
        source,
        rawPrice,
        price,
        observedAt: observedAtSeconds
      });
      const quorum = source === "snapshot" ? 1 : Number(process.env.ORACLE_SOURCE_QUORUM || 1);
      const accepted = isQuoteAccepted(quote, quorum);
      const confidence = confidenceBps(source);
      const rejectionReason = accepted
        ? null
        : quote.smoothing?.reason
          || (quote.indicative === true || quote.tradable === false
            ? "indicative observations are not authoritative"
            : "source quorum " + sourceCount(quote) + "/" + quorum);

      await ensurePartitionForTimestamp(client, "source_observations", observedAt);
      await ensurePartitionForTimestamp(client, "oracle_mark_history", observedAt);
      await client.query(
        "INSERT INTO source_observations("
        + "market_id,source,raw_price,observed_at,source_hash,accepted,rejection_reason,metadata"
        + ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
        [
          marketId,
          source,
          String(rawPrice),
          observedAt,
          sourceHash,
          accepted,
          rejectionReason,
          quote
        ]
      );
      await insertSecondaryObservation(client, marketId, quote);
      if (!accepted || !protocolMarketIds.has(marketId)) continue;

      await client.query(
        "INSERT INTO oracle_marks("
        + "market_id,price,confidence_bps,observed_at,source,source_hash,source_count,metadata,updated_at"
        + ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) "
        + "ON CONFLICT (market_id) DO UPDATE SET "
        + "price=EXCLUDED.price,confidence_bps=EXCLUDED.confidence_bps,"
        + "observed_at=EXCLUDED.observed_at,source=EXCLUDED.source,"
        + "source_hash=EXCLUDED.source_hash,source_count=EXCLUDED.source_count,"
        + "metadata=EXCLUDED.metadata,updated_at=now() "
        + "WHERE oracle_marks.observed_at <= EXCLUDED.observed_at",
        [
          marketId,
          String(price),
          confidence,
          observedAt,
          source,
          sourceHash,
          sourceCount(quote),
          { quote }
        ]
      );
      const historyInsert = await client.query(
        "INSERT INTO oracle_mark_history("
        + "market_id,price,confidence_bps,observed_at,source,source_hash,metadata"
        + ") VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING 1",
        [marketId, String(price), confidence, observedAt, source, sourceHash, { quote }]
      );
      if (historyInsert.rowCount) {
        await upsertCandle(client, marketId, observedAt, price, 60);
        await upsertCandle(client, marketId, observedAt, price, 3_600);
        await upsertCandle(client, marketId, observedAt, price, 86_400);
      }
    }
  });

  return {
    successfulMarkets: result.successfulMarkets,
    failures: result.failures.length,
    failureMarkets: result.failures.slice(0, 20),
    observedAt: new Date().toISOString()
  };
}

function previousPriceMap(markRows, constituentRows) {
  const prices = {};
  for (const row of constituentRows || []) {
    if (row?.market_id && row.metadata) prices[row.market_id] = row.metadata;
  }
  for (const row of markRows || []) {
    if (row?.market_id && row.metadata?.quote) prices[row.market_id] = row.metadata.quote;
  }
  return prices;
}

async function syncMarkets(pool) {
  for (const market of activeRegistryMarkets()) {
    await pool.query(
      "INSERT INTO markets("
      + "market_id,symbol,display_name,market_type,live,price_floor,metadata"
      + ") VALUES ($1,$2,$3,$4,$5,$6,$7) "
      + "ON CONFLICT (market_id) DO UPDATE SET "
      + "symbol=EXCLUDED.symbol,display_name=EXCLUDED.display_name,"
      + "market_type=EXCLUDED.market_type,live=EXCLUDED.live,"
      + "price_floor=EXCLUDED.price_floor,metadata=EXCLUDED.metadata,updated_at=now()",
      [
        market.priceApiMarket,
        market.symbol,
        market.displayName || market.name || market.priceApiMarket,
        market.type,
        Boolean(market.live !== false),
        String(Math.round(Number(market.priceFloorUsd) * 1_000_000)),
        market
      ]
    );
  }
}

async function ensurePartitions(client) {
  for (const parent of ["source_observations", "oracle_mark_history"]) {
    await client.query(
      "SELECT ensure_month_partition($1,date_trunc('month',now())::date)",
      [parent]
    );
    await client.query(
      "SELECT ensure_month_partition($1,(date_trunc('month',now()) + interval '1 month')::date)",
      [parent]
    );
  }
}

async function ensurePartitionForTimestamp(client, parent, timestamp) {
  await client.query(
    "SELECT ensure_month_partition($1,date_trunc('month',$2::timestamptz)::date)",
    [parent, timestamp]
  );
}

async function enforceRetention(client, force = false) {
  const now = Date.now();
  if (!force && now - lastRetentionAt < 60 * 60 * 1_000) return;
  await client.query("DELETE FROM source_observations WHERE observed_at < now() - interval '90 days'");
  await client.query("DELETE FROM oracle_mark_history WHERE observed_at < now() - interval '90 days'");
  await client.query("DELETE FROM candles WHERE interval_seconds=60 AND bucket < now() - interval '90 days'");
  lastRetentionAt = now;
}

async function upsertCandle(client, marketId, observedAt, price, intervalSeconds) {
  await client.query(
    "INSERT INTO candles(market_id,bucket,interval_seconds,open,high,low,close,observations) "
    + "VALUES ($1,to_timestamp(floor(extract(epoch from $2::timestamptz)/$3)*$3),$3,$4,$4,$4,$4,1) "
    + "ON CONFLICT (market_id,interval_seconds,bucket) DO UPDATE SET "
    + "high=greatest(candles.high,EXCLUDED.high),low=least(candles.low,EXCLUDED.low),"
    + "close=EXCLUDED.close,observations=candles.observations+1",
    [marketId, observedAt, intervalSeconds, String(price)]
  );
}

function hashSource(value) {
  return "0x" + crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => JSON.stringify(key) + ":" + stableStringify(entry))
      .join(",") + "}";
  }
  return JSON.stringify(value);
}

function confidenceBps(source) {
  if (/^hoodliquid-hl\d+-seed$/.test(source)) return 0;
  if (/^hoodliquid-hl\d+$/.test(source)) return 9_500;
  if (source === "poketrace-ewap") return 9_750;
  if (source === "poketrace-aggregate") return 9_400;
  if (
    source === "tcgplayer-api"
    || source === "tcgplayer-playwright"
  ) return 9_500;
  return 9_000;
}

function sourceCount(quote) {
  return Math.max(1, Number(
    quote.independentSourceCount || quote.liveConstituentCount || 1
  ));
}

function isQuoteAccepted(quote, quorum = 1) {
  return quote.smoothing?.status !== "rejected"
    && quote.indicative !== true
    && quote.tradable !== false
    && sourceCount(quote) >= Number(quorum);
}

async function insertSecondaryObservation(client, marketId, quote) {
  const priceUsd = Number(quote.secondaryPrice || quote.tcgplayerFallbackPrice || 0);
  const source = String(quote.secondarySource || quote.tcgplayerFallbackSource || "");
  if (priceUsd <= 0 || !source || source === quote.source) return;
  const rawPrice = Math.round(priceUsd * 1_000_000);
  const observedAtSeconds = Number(
    quote.secondaryObservedAt
    || quote.tcgplayerFallbackObservedAt
    || quote.lastUpdateTime
    || 0
  );
  if (observedAtSeconds <= 0) return;
  const observedAt = new Date(observedAtSeconds * 1_000);
  const accepted = quote.crossSource?.status === "confirmed";
  const sourceHash = hashSource({
    marketId,
    source,
    rawPrice,
    price: rawPrice,
    observedAt: observedAtSeconds
  });
  await ensurePartitionForTimestamp(client, "source_observations", observedAt);
  await client.query(
    "INSERT INTO source_observations("
    + "market_id,source,raw_price,observed_at,source_hash,accepted,rejection_reason,metadata"
    + ") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
    [
      marketId,
      source,
      String(rawPrice),
      observedAt,
      sourceHash,
      accepted,
      accepted ? null : "cross-source outlier",
      { crossSource: quote.crossSource }
    ]
  );
}

if (require.main === module) {
  main().catch((error) => {
    logger.fatal({ err: error }, "Market-data worker failed");
    process.exitCode = 1;
  });
}

module.exports = {
  confidenceBps,
  enforceRetention,
  ensurePartitionForTimestamp,
  hashSource,
  ingestCycle,
  isQuoteAccepted,
  previousPriceMap,
  sourceCount,
  stableStringify,
  syncMarkets
};
