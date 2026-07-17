const { expect } = require("chai");
const { buildIndexQuote } = require("../scripts/scrape-tcgplayer-prices.cjs");
const list = require("../data/oracle/hl300-constituents.json");

const index = { indexMarket: { priceApiMarket: "HL300" }, list };
const priceFloors = { defaultFloorUsd: 0, markets: { HL300: 10000 } };

function pricesWithStale(staleIds, staleAgeSeconds = 6 * 3600, now = Math.floor(Date.now() / 1000)) {
  const all = staleIds === "ALL";
  const stale = new Set(all ? [] : staleIds);
  const prices = {};
  for (const constituent of list.constituents) {
    const scaled = Math.round(constituent.seedPriceUsd * 1_000_000);
    prices[constituent.id] = {
      price: scaled,
      rawPrice: scaled,
      source: "tcgplayer-playwright",
      lastUpdateTime: all || stale.has(constituent.id) ? now - staleAgeSeconds : now - 60
    };
  }
  return prices;
}

describe("HL300 carry-forward (no staleness cap)", function () {
  const now = Math.floor(Date.now() / 1000);
  const expectedSum = list.constituents.reduce((total, c) => total + Math.round(c.seedPriceUsd * 1_000_000), 0);

  it("stays tradable with a few carried constituents and reports fresh observed time", function () {
    const carriedId = list.constituents[0].id;
    const quote = buildIndexQuote({ index, prices: pricesWithStale([carriedId], 6 * 3600, now), previousQuote: null, priceFloors, now });
    expect(quote.source).to.equal("hoodliquid-hl300");
    expect(quote.tradable).to.not.equal(false);
    expect(quote.staleCount).to.equal(1);
    expect(quote.staleIds).to.deep.equal([carriedId]);
    // Observed time reflects only the fresh set (~60s), not the 6h-stale card.
    expect(now - quote.lastUpdateTime).to.be.lessThan(1_800);
    expect(quote.rawPrice).to.equal(expectedSum);
  });

  it("stays tradable with many carried constituents (no count cap)", function () {
    const many = list.constituents.slice(0, 60).map((c) => c.id);
    const quote = buildIndexQuote({ index, prices: pricesWithStale(many, 2 * 3600, now), previousQuote: null, priceFloors, now });
    expect(quote.source).to.equal("hoodliquid-hl300");
    expect(quote.tradable).to.not.equal(false);
    expect(quote.staleCount).to.equal(60);
  });

  it("stays tradable even when all 300 constituents are carried for days (no carry-age cap)", function () {
    const quote = buildIndexQuote({ index, prices: pricesWithStale("ALL", 200 * 3600, now), previousQuote: null, priceFloors, now });
    expect(quote.source).to.equal("hoodliquid-hl300");
    expect(quote.tradable).to.not.equal(false);
    expect(quote.staleCount).to.equal(list.constituents.length);
    // With no fresh constituent the mark is stamped at the current cycle time.
    expect(now - quote.lastUpdateTime).to.be.lessThan(120);
    expect(quote.rawPrice).to.equal(expectedSum);
  });

  it("is indicative only when a constituent has never been priced", function () {
    const quote = buildIndexQuote({ index, prices: {}, previousQuote: null, priceFloors, now });
    expect(quote.source).to.equal("hoodliquid-hl300-seed");
    expect(quote.tradable).to.equal(false);
    expect(quote.unpricedCount).to.equal(list.constituents.length);
    expect(quote.liveConstituentCount).to.equal(0);
  });
});
