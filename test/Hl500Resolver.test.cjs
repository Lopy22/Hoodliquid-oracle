const { expect } = require("chai");
const {
  extractProductIds,
  scoreProductMatch,
  searchTerms,
  stripCardDecorators,
  tokenOverlapScore
} = require("../scripts/resolve-hl500-tcgplayer-ids.cjs");

describe("HL500 TCGPlayer resolver", function () {
  it("builds focused search terms from a constituent row", function () {
    const row = {
      card: "Umbreon ex - 161/131",
      set: "SV: Prismatic Evolutions"
    };
    expect(searchTerms(row)).to.deep.equal([
      "Umbreon ex - 161/131 SV: Prismatic Evolutions",
      "Umbreon ex",
      "Umbreon ex - 161/131"
    ]);
  });

  it("scores the correct product above unrelated products", function () {
    const row = {
      card: "Mega Charizard X ex - 125/094",
      set: "ME02: Phantasmal Flames"
    };
    const correct = {
      productId: 662184,
      name: "Mega Charizard X ex - 125/094",
      groupName: "ME02: Phantasmal Flames"
    };
    const unrelated = {
      productId: 1,
      name: "Mega Charizard X ex Booster Box",
      groupName: "Other Set"
    };

    expect(scoreProductMatch(row, correct)).to.be.greaterThan(85);
    expect(scoreProductMatch(row, unrelated)).to.be.lessThan(scoreProductMatch(row, correct));
  });

  it("normalizes common TCGPlayer search response product IDs", function () {
    expect(extractProductIds({ results: [1, { productId: 2 }, { id: 3 }] })).to.deep.equal([1, 2, 3]);
  });

  it("strips card-number decorators for broader search fallback", function () {
    expect(stripCardDecorators("Mega Charizard X ex - 125/094")).to.equal("Mega Charizard X ex");
    expect(tokenOverlapScore("Mega Charizard X ex", "Mega Charizard X ex - 125/094")).to.equal(100);
  });
});
