const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  hl500MappingStatus,
  isHl500MarketLive
} = require("../scripts/hl500-market.cjs");

describe("HoodLiquid HL500 constituent index", function () {
  const previousConstituents = process.env.ORACLE_HL500_CONSTITUENTS;
  const previousEnabled = process.env.ORACLE_HL500_ENABLED;

  afterEach(function () {
    if (previousConstituents === undefined) {
      delete process.env.ORACLE_HL500_CONSTITUENTS;
    } else {
      process.env.ORACLE_HL500_CONSTITUENTS = previousConstituents;
    }
    if (previousEnabled === undefined) delete process.env.ORACLE_HL500_ENABLED;
    else process.env.ORACLE_HL500_ENABLED = previousEnabled;
  });

  it("keeps HL500 unavailable while the committed basket is incomplete", function () {
    const status = hl500MappingStatus();
    expect(status).to.include({
      count: 500,
      mapped: 0,
      usable: 0,
      snapshots: 0,
      missing: 500,
      ready: false
    });
    expect(isHl500MarketLive(46630)).to.equal(false);
    expect(isHl500MarketLive(4663)).to.equal(false);
  });

  it("uses the same complete HoodLiquid basket gate on testnet and mainnet", function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hoodliquid-hl500-"));
    const constituentsPath = path.join(directory, "constituents.json");
    const constituents = Array.from({ length: 500 }, (_, index) => index < 8
      ? { id: "HL500-" + String(index + 1).padStart(3, "0"), snapshotOnly: true, seedPriceUsd: 1 }
      : { id: "HL500-" + String(index + 1).padStart(3, "0"), tcgplayerId: index + 1 });
    fs.writeFileSync(constituentsPath, JSON.stringify({ constituents }));
    process.env.ORACLE_HL500_CONSTITUENTS = constituentsPath;

    expect(hl500MappingStatus()).to.include({
      count: 500,
      mapped: 492,
      usable: 500,
      snapshots: 8,
      missing: 0,
      ready: true
    });
    expect(isHl500MarketLive(46630)).to.equal(true);
    expect(isHl500MarketLive(4663)).to.equal(true);

    process.env.ORACLE_HL500_ENABLED = "false";
    expect(isHl500MarketLive(46630)).to.equal(false);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("never enables the index on unrelated chains", function () {
    expect(isHl500MarketLive(8453)).to.equal(false);
  });
});
