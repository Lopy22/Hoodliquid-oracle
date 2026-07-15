const crypto = require("node:crypto");
const { createDatabase, withTransaction } = require("../db.cjs");
const { logger } = require("../logger.cjs");
const { argument, runWorker } = require("./loop.cjs");
const { scrapeCycle } = require("../../scripts/scrape-tcgplayer-prices.cjs");
const { activeRegistryMarkets } = require("../../scripts/oracle-market-registry.cjs");
const { isHl500MarketLive, hl500MappingStatus } = require("../../scripts/hl500-market.cjs");

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
      run: () => ingestCycle(pool, network.chainId)
    });
  } finally {
    await pool.end();
  }
}

async function ingestCycle(
  pool,
  chainId = Number(process.env.CHAIN_ID),
  scrape = scrapeCycle
) {
  const [marks, sourceState] = await Promise.all([
    pool.query("SELECT market_id,metadata FROM oracle_marks"),
    pool.query("SELECT state FROM source_state WHERE source='poketrace'")
  ]);
  const previousPrices = Object.fromEntries(
    marks.rows
      .map((row) => [row.market_id, row.metadata?.quote])
      .filter((entry) => Boolean(entry[1]))
  );
  const result = await scrape({
    persist: false,
    quiet: true,
    previousPayload: { prices: previousPrices },
    previousPoketrace: sourceState.rows[0]?.state
  });
  if (result.targetCount > 0 && result.successfulMarkets === 0) {
    throw new Error("all " + result.targetCount + " oracle targets failed");
  }

  const hl500Live = isHl500MarketLive(chainId);
  await withTransaction(pool, async (client) => {
    await ensurePartitions(client);
    await enforceRetention(client);
    await client.query(
      "INSERT INTO source_state(source,state,updated_at) VALUES ('poketrace',$1,now()) "
      + "ON CONFLICT (source) DO UPDATE SET state=EXCLUDED.state,updated_at=now()",
      [result.poketracePayload]
    );

    for (const [marketId, quote] of Object.entries(result.payload.prices)) {
      if (marketId === "HL500" && !hl500Live) continue;
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
      if (!accepted) continue;

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

async function syncMarkets(pool, chainId = Number(process.env.CHAIN_ID)) {
  const hl500Live = isHl500MarketLive(chainId);
  for (const market of activeRegistryMarkets()) {
    const live = market.priceApiMarket !== "HL500" || hl500Live;
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
        Boolean(market.live !== false && live),
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
  if (source === "hoodliquid-hl500-seed") return 0;
  if (source === "hoodliquid-hl500") return 9_500;
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

function isHl500Ready() {
  return hl500MappingStatus().ready;
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
  isHl500Ready,
  sourceCount,
  stableStringify,
  syncMarkets
};
