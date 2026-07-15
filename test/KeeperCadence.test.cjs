const { expect } = require("chai");
const { isKeeperActionDue, withRefreshChange } = require("../scripts/scrape-tcgplayer-prices.cjs");

describe("Oracle keeper cadence", function () {
  it("runs immediately when no prior action is recorded", function () {
    expect(isKeeperActionDue({ lastActionAt: 0, nowMs: 1_800_000_000_000, intervalMs: 300_000 })).to.equal(true);
  });

  it("does not run before the configured interval", function () {
    expect(
      isKeeperActionDue({
        lastActionAt: 1_800_000_000,
        nowMs: 1_800_000_240_000,
        intervalMs: 300_000
      })
    ).to.equal(false);
  });

  it("runs at the configured interval boundary", function () {
    expect(
      isKeeperActionDue({
        lastActionAt: 1_800_000_000,
        nowMs: 1_800_000_300_000,
        intervalMs: 300_000
      })
    ).to.equal(true);
  });

  it("annotates the price move since the previous oracle refresh", function () {
    const quote = withRefreshChange(
      { price: 103_000_000, rawPrice: 104_000_000, source: "tcgplayer-api" },
      { price: 100_000_000, rawPrice: 100_000_000 },
      1_800_000_300
    );

    expect(quote.refreshPreviousPrice).to.equal(100_000_000);
    expect(quote.refreshChange).to.equal(3_000_000);
    expect(quote.refreshChangeUsd).to.equal(3);
    expect(quote.refreshChangeBps).to.equal(300);
    expect(quote.rawRefreshChangeUsd).to.equal(4);
    expect(quote.refreshChangedAt).to.equal(1_800_000_300);
  });
});
