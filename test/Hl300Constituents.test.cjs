const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const { EXCLUDED_IDS, SOURCE_PATH, deriveHl300 } = require("../scripts/build-hl300-constituents.cjs");

describe("HL300 constituent derivation", function () {
  const source = JSON.parse(fs.readFileSync(path.join(process.cwd(), SOURCE_PATH), "utf8"));
  const committed = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/oracle/hl300-constituents.json"), "utf8"));

  it("derives the top 300 valid non-duplicate rows from the HL500 basket", function () {
    const derived = deriveHl300(source);
    expect(derived.count).to.equal(300);
    expect(derived.constituents).to.have.length(300);
    expect(derived.constituents.at(-1).id).to.equal("HL500-320");
    const ids = new Set(derived.constituents.map((row) => row.id));
    for (const excluded of EXCLUDED_IDS) expect(ids.has(excluded), `${excluded} must be excluded`).to.equal(false);
    for (const row of derived.constituents) {
      expect(row.duplicateOf, `${row.id} must not be a duplicate row`).to.equal(undefined);
      expect(Number(row.tcgplayerId)).to.be.greaterThan(0);
    }
    const productIds = derived.constituents.map((row) => Number(row.tcgplayerId));
    expect(new Set(productIds).size).to.equal(300);
    const seedTotal = Math.round(derived.constituents.reduce((sum, row) => sum + Number(row.seedPriceUsd), 0) * 100) / 100;
    expect(derived.seedTotalUsd).to.equal(seedTotal);
  });

  it("matches the committed hl300-constituents.json exactly", function () {
    const derived = deriveHl300(source);
    expect(committed).to.deep.equal(derived);
  });

  it("preserves original HL500 row ids for observation continuity", function () {
    for (const row of committed.constituents) {
      expect(row.id).to.match(/^HL500-\d{3}$/);
    }
  });
});
