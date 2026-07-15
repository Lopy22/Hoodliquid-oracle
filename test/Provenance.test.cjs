const { expect } = require("chai");
const { hashSource } = require("../server/workers/market-data.cjs");

describe("Observation provenance", function () {
  it("hashes market, source, raw price, smoothed price, and observation time", function () {
    const base = {
      marketId: "CHARIZARD-X",
      source: "tcgplayer-api",
      rawPrice: 101_000_000,
      price: 100_300_000,
      observedAt: 1_800_000_000
    };
    const hash = hashSource(base);
    expect(hash).to.match(/^0x[0-9a-f]{64}$/);
    for (const [field, value] of Object.entries({
      marketId: "CHARIZARD-151",
      source: "poketrace-ewap",
      rawPrice: 102_000_000,
      price: 100_400_000,
      observedAt: 1_800_000_001
    })) {
      expect(hashSource({ ...base, [field]: value })).not.to.equal(hash);
    }
  });
});
