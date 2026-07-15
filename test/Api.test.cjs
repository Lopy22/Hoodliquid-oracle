const { expect } = require("chai");
const request = require("supertest");
const { createApp } = require("../server/api.cjs");

describe("Read-only price API", function () {
  const now = Date.parse("2026-07-15T00:00:00.000Z");
  const network = { chainId: 46630, key: "robinhood-testnet" };

  it("enforces supported and configured chain IDs", async function () {
    const app = createApp({ pool: pricePool([]), network, now: () => now });
    await request(app).get("/api/v1/8453/prices").expect(404);
    await request(app).get("/api/v1/4663/prices").expect(404);
  });

  it("serializes fixed-precision prices and fresh tradability", async function () {
    const app = createApp({
      pool: pricePool([{
        market_id: "CHARIZARD-X",
        live: true,
        price: "854250000",
        confidence_bps: 9500,
        observed_at: new Date(now - 60_000),
        source: "tcgplayer-playwright",
        source_hash: "0x" + "1".repeat(64),
        source_count: 1,
        metadata: {
          quote: {
            rawPrice: 855000000,
            sourceObservedAt: Math.floor((now - 60_000) / 1_000),
            smoothing: { tier: "direct", alpha: 1 }
          }
        }
      }]),
      network,
      now: () => now
    });
    const response = await request(app).get("/api/v1/46630/prices").expect(200);
    expect(response.body).to.include({ chainId: 46630, priceScale: 1_000_000 });
    expect(response.body.prices["CHARIZARD-X"]).to.include({
      price: "854250000",
      rawPrice: "855000000",
      priceUsd: 854.25,
      rawPriceUsd: 855,
      stale: false,
      tradable: true
    });
  });

  it("marks old observations stale and non-tradable", async function () {
    const app = createApp({
      pool: pricePool([{
        market_id: "PL500",
        live: true,
        price: "10000000000",
        confidence_bps: 8500,
        observed_at: new Date(now - 1_900_000),
        source: "pokeliquid-api",
        source_hash: "0x" + "2".repeat(64),
        source_count: 1,
        metadata: { quote: { rawPrice: 10000000000 } }
      }]),
      network,
      now: () => now
    });
    const response = await request(app).get("/api/v1/46630/prices").expect(200);
    expect(response.body.prices.PL500).to.include({ stale: true, tradable: false });
  });

  it("always exposes liveness", async function () {
    const app = createApp({ pool: pricePool([]), network, now: () => now });
    const response = await request(app).get("/health/live").expect(200);
    expect(response.body).to.include({ live: true, chainId: 46630 });
  });
});

function pricePool(rows) {
  return {
    async query(sql) {
      if (sql.includes("FROM markets m LEFT JOIN oracle_marks")) {
        return { rowCount: rows.length, rows };
      }
      throw new Error("Unexpected query in API test: " + sql);
    }
  };
}
