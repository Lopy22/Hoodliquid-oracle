const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const { extractMarketPrice, selectPricedSku } = require("../scripts/scrape-tcgplayer-prices.cjs");

describe("TCGPlayer Near Mint parser", function () {
  it("reads a condition-labelled Near Mint market price", function () {
    const text = fs.readFileSync(
      path.join(__dirname, "fixtures", "tcgplayer-near-mint.txt"),
      "utf8"
    );
    expect(extractMarketPrice(text)).to.equal(136.85);
  });

  it("reads the Near Mint comparison price when another condition is selected", function () {
    const text = "Price Points Damaged Holofoil Market Price $46.14 Near Mint Comparison Prices Holofoil: $136.85";
    expect(extractMarketPrice(text)).to.equal(136.85);
  });

  it("rejects unlabelled market values", function () {
    const text = "Market Price $46.14 Latest Sales $44.00";
    expect(extractMarketPrice(text)).to.equal(null);
  });

  it("rejects non-Near-Mint SKU fallback by default", async function () {
    let message = "";
    try {
      await selectPricedSku({
        skus: [{ productConditionId: 123, conditionId: 3, languageId: 1 }],
        token: "test",
        baseUrl: "https://api.tcgplayer.com",
        market: {
          tcgplayerId: 662184,
          conditionName: "Near Mint",
          conditionId: 1,
          languageId: 1
        }
      });
    } catch (error) {
      message = error.message;
    }
    expect(message).to.contain("found no Near Mint English SKU");
  });
});
