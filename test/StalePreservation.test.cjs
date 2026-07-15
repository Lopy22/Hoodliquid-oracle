const { expect } = require("chai");
const { withRefreshChange } = require("../scripts/scrape-tcgplayer-prices.cjs");

describe("Failed-source timestamp preservation", function () {
  it("does not make a retained quote look newly observed", function () {
    const oldTimestamp = 1_700_000_000;
    const previous = {
      price: 123_000_000,
      rawPrice: 124_000_000,
      lastUpdateTime: oldTimestamp,
      sourceObservedAt: oldTimestamp,
      source: "tcgplayer-playwright"
    };
    const retained = withRefreshChange(previous, previous, oldTimestamp + 3_600);
    expect(retained.lastUpdateTime).to.equal(oldTimestamp);
    expect(retained.sourceObservedAt).to.equal(oldTimestamp);
    expect(retained.refreshChangedAt).to.equal(oldTimestamp + 3_600);
  });
});
