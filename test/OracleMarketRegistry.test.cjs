const { expect } = require("chai");
const {
  cardOracleTargets,
  loadOracleMarketRegistry,
  registryPriceFloors
} = require("../scripts/oracle-market-registry.cjs");

describe("Oracle market registry", function () {
  it("defines live HL300, retired HL500, and the six supported Charizard markets", function () {
    const registry = loadOracleMarketRegistry();
    expect(registry.markets.map((market) => market.priceApiMarket)).to.deep.equal([
      "HL300",
      "HL500",
      "CHARIZARD-X",
      "CHARIZARD-151",
      "CHARIZARD-VSTAR-SWSH262",
      "CHARIZARD-EX-SIR-OF",
      "MEGA-CHARIZARD-X-023",
      "CHARIZARD-BS"
    ]);
  });

  it("uses Near Mint English TCGPlayer products for every card oracle target", function () {
    const targets = cardOracleTargets();
    expect(targets).to.have.length(6);
    for (const target of targets) {
      expect(target.tcgplayerId).to.be.a("number").and.greaterThan(0);
      expect(target.conditionName).to.equal("Near Mint");
      expect(target.conditionId).to.equal(1);
      expect(target.languageId).to.equal(1);
      expect(target.tcgplayerUrl).to.contain(String(target.tcgplayerId));
      expect(target.poketraceEligible).to.equal(true);
    }
  });

  it("provides all price floors from the same registry", function () {
    const floors = registryPriceFloors();
    expect(floors.HL300).to.equal(10000);
    expect(floors["CHARIZARD-X"]).to.equal(100);
    expect(Object.keys(floors)).to.have.length(7);
  });
});
