const { expect } = require("chai");
const { PRICE_SCALE, smoothQuote } = require("../scripts/oracle-smoothing.cjs");

describe("Oracle adaptive EWMA", function () {
  const now = 1_700_000_000;
  const previous = {
    price: 100 * PRICE_SCALE,
    rawPrice: 100 * PRICE_SCALE,
    ewma: 100,
    lastUpdateTime: now - 300,
    source: "tcgplayer-api"
  };

  it("passes deviations below 3% through directly", function () {
    const quote = smoothQuote(102 * PRICE_SCALE, previous, now, "tcgplayer-api");
    expect(quote.price).to.equal(102 * PRICE_SCALE);
    expect(quote.smoothing.tier).to.equal("direct");
    expect(quote.smoothing.alpha).to.equal(1);
  });

  it("uses alpha 0.3 for 3-5% deviations", function () {
    const quote = smoothQuote(104 * PRICE_SCALE, previous, now, "tcgplayer-api");
    expect(quote.price).to.equal(101.2 * PRICE_SCALE);
    expect(quote.smoothing.tier).to.equal("moderate");
    expect(quote.smoothing.alpha).to.equal(0.3);
  });

  it("uses alpha 0.1 for 5-15% deviations", function () {
    const quote = smoothQuote(110 * PRICE_SCALE, previous, now, "tcgplayer-api");
    expect(quote.price).to.equal(101 * PRICE_SCALE);
    expect(quote.smoothing.tier).to.equal("heavy");
    expect(quote.smoothing.alpha).to.equal(0.1);
  });

  it("uses alpha 0.01 above 15% instead of accepting the spike", function () {
    const quote = smoothQuote(120 * PRICE_SCALE, previous, now, "tcgplayer-api");
    expect(quote.price).to.equal(100.2 * PRICE_SCALE);
    expect(quote.smoothing.tier).to.equal("spike");
    expect(quote.smoothing.alpha).to.equal(0.01);
  });

  it("rejects a value below the configured floor without refreshing its timestamp", function () {
    const quote = smoothQuote(40 * PRICE_SCALE, previous, now, "tcgplayer-api", {
      priceFloor: 50 * PRICE_SCALE
    });
    expect(quote.price).to.equal(previous.price);
    expect(quote.lastUpdateTime).to.equal(previous.lastUpdateTime);
    expect(quote.smoothing.status).to.equal("rejected");
    expect(quote.smoothing.tier).to.equal("floor");
  });

  it("does not initialize a market from a below-floor observation", function () {
    expect(() => smoothQuote(
      40 * PRICE_SCALE,
      null,
      now,
      "tcgplayer-api",
      { priceFloor: 50 * PRICE_SCALE }
    )).to.throw("below configured floor");
  });
});
