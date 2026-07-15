const { expect } = require("chai");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  fetchPokeliquidPl500Quote,
  isPl500MarketLive,
  pl500MappingStatus,
  pl500Source
} = require("../scripts/pl500-market.cjs");

describe("PokeLiquid PL500 testnet source", function () {
  const now = 1_800_000_000;
  const previousSource = process.env.ORACLE_PL500_SOURCE;
  const previousConstituents = process.env.ORACLE_PL500_CONSTITUENTS;

  beforeEach(function () {
    process.env.ORACLE_PL500_SOURCE = "pokeliquid-api";
  });

  after(function () {
    if (previousSource === undefined) delete process.env.ORACLE_PL500_SOURCE;
    else process.env.ORACLE_PL500_SOURCE = previousSource;
    if (previousConstituents === undefined) delete process.env.ORACLE_PL500_CONSTITUENTS;
    else process.env.ORACLE_PL500_CONSTITUENTS = previousConstituents;
  });

  it("accepts a fresh signed-history observation", async function () {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(__dirname, "fixtures", "pokeliquid-pl500.json"), "utf8")
    );
    const quote = await fetchPokeliquidPl500Quote({
      now,
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return fixture;
        }
      })
    });

    expect(quote).to.include({
      source: "pokeliquid-api",
      observedAt: now - 120,
      rawPriceUsd: 105_008.54,
      upstreamEwmaUsd: 105_001.25,
      upstreamId: 99
    });
  });

  it("rejects stale observations and missing transaction identity", async function () {
    const response = (timestamp, signature = "1".repeat(88)) => async () => ({
      ok: true,
      async json() {
        return [{ timestamp, raw_price: 100_000, ewma: 100_000, tx_signature: signature }];
      }
    });
    await expect(fetchPokeliquidPl500Quote({ now, maxAgeSeconds: 900, fetchImpl: response(now - 901) }))
      .to.be.rejectedWith("stale");
    await expect(fetchPokeliquidPl500Quote({ now, fetchImpl: response(now - 60, "missing") }))
      .to.be.rejectedWith("transaction signature");
  });

  it("rejects future and nonpositive upstream observations", async function () {
    const response = (timestamp, rawPrice) => async () => ({
      ok: true,
      async json() {
        return [{
          timestamp,
          raw_price: rawPrice,
          ewma: 100_000,
          tx_signature: "1".repeat(88)
        }];
      }
    });
    await expect(fetchPokeliquidPl500Quote({
      now,
      fetchImpl: response(now + 301, 100_000)
    })).to.be.rejectedWith("future");
    await expect(fetchPokeliquidPl500Quote({
      now,
      fetchImpl: response(now - 60, 0)
    })).to.be.rejectedWith("invalid price");
  });

  it("enables the external source only for testnet while mainnet retains the mapping gate", function () {
    expect(pl500MappingStatus().ready).to.equal(false);
    expect(pl500Source()).to.equal("pokeliquid-api");
    expect(isPl500MarketLive(46630)).to.equal(true);
    expect(isPl500MarketLive(4663)).to.equal(false);
    expect(isPl500MarketLive(8453)).to.equal(false);
  });

  it("requires the constituent source even after mainnet mappings become complete", function () {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hoodliquid-pl500-"));
    const constituentsPath = path.join(directory, "constituents.json");
    const constituents = Array.from({ length: 500 }, (_, index) => index < 8
      ? { id: `snapshot-${index}`, snapshotOnly: true, seedPriceUsd: 1 }
      : { id: `mapped-${index}`, tcgplayerId: index + 1 });
    fs.writeFileSync(constituentsPath, JSON.stringify({ constituents }));
    process.env.ORACLE_PL500_CONSTITUENTS = constituentsPath;

    expect(pl500MappingStatus().ready).to.equal(true);
    process.env.ORACLE_PL500_SOURCE = "pokeliquid-api";
    expect(isPl500MarketLive(46630)).to.equal(true);
    expect(isPl500MarketLive(4663)).to.equal(false);
    process.env.ORACLE_PL500_SOURCE = "constituents";
    expect(isPl500MarketLive(4663)).to.equal(true);

    fs.rmSync(directory, { recursive: true, force: true });
  });
});
