const express = require("express");
const { createDatabase } = require("./db.cjs");
const { logger } = require("./logger.cjs");
const { readinessReport } = require("./readiness.cjs");

const PRICE_SCALE = 1_000_000;

function createApp({ pool, network, now = () => Date.now() }) {
  const app = express();
  app.disable("x-powered-by");
  app.use((_request, response, next) => {
    response.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'"
    });
    next();
  });

  app.get("/health/live", (_request, response) => {
    response.json({
      live: true,
      service: "hoodliquid-oracle",
      chainId: network.chainId,
      checkedAt: new Date(now()).toISOString()
    });
  });

  app.get("/health/ready", async (_request, response, next) => {
    try {
      const report = await readinessReport(pool, network, { nowMs: now() });
      response.status(report.ready ? 200 : 503).json(report);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/v1/:chainId/prices", async (request, response, next) => {
    try {
      const requestedChainId = Number(request.params.chainId);
      if (![4663, 46630].includes(requestedChainId)) {
        return response.status(404).json({ error: "Unsupported chain ID" });
      }
      if (requestedChainId !== network.chainId) {
        return response.status(404).json({
          error: "This oracle node serves chain " + network.chainId
        });
      }

      const result = await pool.query(
        "SELECT m.market_id,m.live,o.price,o.confidence_bps,o.observed_at,"
        + "o.source,o.source_hash,o.source_count,o.metadata "
        + "FROM markets m LEFT JOIN oracle_marks o ON o.market_id=m.market_id "
        + "WHERE m.live=true ORDER BY m.market_id"
      );
      const nowMs = now();
      const maxAgeSeconds = Number(process.env.ORACLE_MARK_MAX_AGE_SECONDS || 1_800);
      const prices = {};
      let latest = 0;
      for (const row of result.rows) {
        if (!row.observed_at || !row.price) continue;
        const quote = row.metadata?.quote || {};
        const observedAtMs = new Date(row.observed_at).getTime();
        const observedAt = Math.floor(observedAtMs / 1_000);
        const ageSeconds = Math.floor((nowMs - observedAtMs) / 1_000);
        const stale = ageSeconds < 0 || ageSeconds > maxAgeSeconds;
        const rawPrice = integerString(quote.rawPrice || row.price);
        const price = integerString(row.price);
        const indicative = quote.indicative === true || quote.tradable === false;
        prices[row.market_id] = {
          price,
          rawPrice,
          priceUsd: Number(price) / PRICE_SCALE,
          rawPriceUsd: Number(rawPrice) / PRICE_SCALE,
          confidenceBps: Number(row.confidence_bps),
          source: row.source,
          sourceCount: Number(row.source_count),
          sourceHash: row.source_hash,
          observedAt,
          observedAtIso: new Date(observedAtMs).toISOString(),
          smoothing: quote.smoothing || null,
          sourceMetadata: publicSourceMetadata(quote),
          stale,
          tradable: Boolean(row.live && !stale && !indicative)
        };
        latest = Math.max(latest, observedAtMs);
      }

      response.set("Cache-Control", "public, max-age=5, stale-while-revalidate=10");
      return response.json({
        chainId: network.chainId,
        priceScale: PRICE_SCALE,
        updatedAt: latest ? new Date(latest).toISOString() : null,
        prices
      });
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _request, response, _next) => {
    logger.error({ err: error }, "API request failed");
    response.status(500).json({ error: "Internal server error" });
  });

  return app;
}

function integerString(value) {
  const string = String(value);
  if (!/^[0-9]+$/.test(string)) throw new Error("Price is not a canonical integer");
  return string.replace(/^0+(?=\d)/, "");
}

function publicSourceMetadata(quote) {
  return {
    sourceObservedAt: quote.sourceObservedAt || quote.lastUpdateTime || null,
    secondarySource: quote.secondarySource || null,
    secondaryObservedAt: quote.secondaryObservedAt || null,
    crossSource: quote.crossSource || null,
    method: quote.method || null,
    priceFloor: quote.priceFloor ? integerString(quote.priceFloor) : null,
    constituentCount: numberOrNull(quote.constituentCount),
    freshConstituentCount: numberOrNull(quote.liveConstituentCount),
    carriedConstituentCount: numberOrNull(quote.staleCount),
    neverPricedConstituentCount: numberOrNull(quote.unpricedCount),
    oldestCarryAgeSeconds: numberOrNull(quote.oldestStaleAgeSeconds),
    constituentFreshnessSeconds: numberOrNull(quote.freshnessSeconds)
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function main() {
  const { network, pool } = createDatabase(process.env.CHAIN_ID);
  const app = createApp({ pool, network });
  const server = app.listen(network.apiPort, network.host, () => {
    logger.info(
      { chainId: network.chainId, host: network.host, port: network.apiPort },
      "Oracle API listening"
    );
  });

  const stop = (signal) => {
    logger.info({ signal }, "Stopping oracle API");
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
}

if (require.main === module) {
  main().catch((error) => {
    logger.fatal({ err: error }, "Oracle API failed");
    process.exitCode = 1;
  });
}

module.exports = { createApp, integerString, numberOrNull, publicSourceMetadata };
