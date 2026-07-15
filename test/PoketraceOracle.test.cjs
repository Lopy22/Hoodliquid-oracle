const { expect } = require("chai");
const { computePoketraceAggregatePrice, computePoketracePrice, normalizeCondition, normalizeListing } = require("../scripts/poketrace-oracle.cjs");

describe("PokeTrace primary oracle", function () {
  const now = 1_800_000_000;

  it("builds a clean Near Mint median and excludes flagged, graded, and foreign comps", function () {
    const listings = [
      comp(95, now - 400),
      comp(100, now - 300),
      comp(100, now - 200),
      comp(105, now - 100),
      comp(100, now - 50),
      { ...comp(1_000, now - 10), anomalyFlag: true },
      { ...comp(500, now - 10), grader: "PSA", grade: "10" },
      { ...comp(90, now - 10), currency: "EUR" }
    ];

    const result = computePoketracePrice(listings, { now, minComps: 5, halfLifeDays: 7 });
    expect(result.cleanMedian).to.equal(100);
    expect(result.compCount).to.equal(5);
    expect(result.rejectedCompCount).to.equal(3);
    expect(result.rejectionBreakdown).to.deep.include({
      nonUsd: 1,
      anomalyFlag: 1,
      graded: 1
    });
    expect(result.cleanCompHash).to.match(/^0x[0-9a-f]{64}$/);
  });

  it("bounds recency-weighted EWAP to 15% around the clean median", function () {
    const year = 365 * 24 * 60 * 60;
    const listings = [
      comp(80, now - year),
      comp(90, now - year),
      comp(100, now - year),
      comp(110, now - 60),
      comp(120, now - 30)
    ];

    const result = computePoketracePrice(listings, { now, minComps: 5, halfLifeDays: 1 });
    expect(result.cleanMedian).to.equal(100);
    expect(result.ewap).to.be.greaterThan(115);
    expect(result.anchoredEwap).to.equal(115);
  });

  it("rejects primary coverage when clean eBay liquidity is insufficient", function () {
    expect(() => computePoketracePrice([comp(100, now - 60)], { now, minComps: 5 })).to.throw(
      "only 1 clean Near Mint eBay comps; 5 required"
    );
  });

  it("normalizes common Near Mint condition strings", function () {
    expect(normalizeCondition("Near Mint")).to.equal("NEAR_MINT");
    expect(normalizeCondition("NM")).to.equal("NEAR_MINT");
    expect(normalizeCondition("near-mint")).to.equal("NEAR_MINT");
  });

  it("filters graded eBay titles before median/EWAP pricing", function () {
    const listings = [
      comp(95, now - 500),
      { ...comp(100, now - 400), condition: "Near Mint" },
      comp(100, now - 300),
      comp(105, now - 200),
      comp(100, now - 100),
      { ...comp(1000, now - 50), title: "Charizard Base Set PSA 10" }
    ];

    const result = computePoketracePrice(listings, { now, minComps: 5, halfLifeDays: 7 });
    expect(result.compCount).to.equal(5);
    expect(result.rejectionBreakdown.graded).to.equal(1);
    expect(result.cleanMedian).to.equal(100);
  });

  it("normalizes nested PokeTrace listing price payloads", function () {
    const listing = normalizeListing({
      price: { value: "123.45", currency: "usd" },
      sold_at: new Date(now * 1000).toISOString(),
      conditionName: "Near Mint"
    });

    expect(listing.price).to.equal(123.45);
    expect(listing.currency).to.equal("USD");
    expect(listing.condition).to.equal("NEAR_MINT");
    expect(listing.soldAt).to.equal(now);
  });

  it("uses free-plan aggregate Near Mint pricing when sold listings are unavailable", function () {
    const result = computePoketraceAggregatePrice({
      prices: {
        ebay: {
          NEAR_MINT: { avg: 180.1234567, saleCount: 45, approxSaleCount: true }
        },
        tcgplayer: {
          NEAR_MINT: { avg: 165, saleCount: 89, approxSaleCount: false }
        }
      }
    });

    expect(result.priceUsd).to.equal(180.123457);
    expect(result.source).to.equal("ebay");
    expect(result.tier).to.equal("NEAR_MINT");
    expect(result.saleCount).to.equal(45);
    expect(result.approxSaleCount).to.equal(true);
  });

  it("falls back to TCGPlayer aggregate when eBay Near Mint pricing is missing", function () {
    const result = computePoketraceAggregatePrice({
      prices: {
        tcgplayer: {
          NEAR_MINT: { avg: 165, saleCount: 89, approxSaleCount: false }
        }
      }
    });

    expect(result.priceUsd).to.equal(165);
    expect(result.source).to.equal("tcgplayer");
  });
});

function comp(price, soldAt) {
  return {
    price,
    currency: "USD",
    soldAt: new Date(soldAt * 1000).toISOString(),
    condition: "NEAR_MINT",
    grader: null,
    grade: null,
    anomalyFlag: false,
    title: "Raw Pokemon card"
  };
}
