const { expect } = require("chai");
const fs = require("node:fs");
const path = require("node:path");
const { deriveHl300 } = require("../scripts/build-hl300-constituents.cjs");

describe("HoodLiquid HL300 constituent index", function () {
  it("derives the live 300-card basket from the fully reviewed HL500 source basket", function () {
    const source = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/oracle/hl500-constituents.json"), "utf8"));
    const committed = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data/oracle/hl300-constituents.json"), "utf8"));
    expect(source.constituents).to.have.length(500);
    expect(source.constituents.every((row) => Number(row.tcgplayerId) > 0)).to.equal(true);
    expect(committed).to.deep.equal(deriveHl300(source));
    expect(committed.constituents).to.have.length(300);
    expect(new Set(committed.constituents.map((row) => row.tcgplayerId)).size).to.equal(300);
  });
});
