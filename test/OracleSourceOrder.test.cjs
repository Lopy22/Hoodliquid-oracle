const { expect } = require("chai");
const { allowPlaywrightFallback, buildIndexQuote, crossSourceStatus, mapWithConcurrency, selectOracleQuote } = require("../scripts/scrape-tcgplayer-prices.cjs");
const { confidenceBps, isQuoteAccepted } = require("../server/workers/market-data.cjs");

describe("Oracle source order", function () {
  const now = 1_800_000_000;
  const market = {
    priceKey: "CHARIZARD-X",
    tcgplayerId: 662184,
    poketraceEligible: true,
    snapshotOnly: false,
    conditionName: "Near Mint",
    conditionId: 1,
    languageId: 1
  };

  afterEach(function () {
    delete process.env.ORACLE_PLAYWRIGHT_FALLBACK;
    delete process.env.ORACLE_PLAYWRIGHT_ENABLED;
    delete process.env.ORACLE_REQUIRE_AUTHENTICATED_SOURCES;
    delete process.env.ORACLE_AUTO_PUBLISH;
    delete process.env.ORACLE_MAX_SOURCE_DEVIATION_BPS;
    delete process.env.ORACLE_PRIMARY_SOURCE;
    delete process.env.ORACLE_TCGPLAYER_SOURCE;
  });

  it("uses TCGPlayer as the default primary and PokeTrace as corroboration", async function () {
    process.env.ORACLE_TCGPLAYER_SOURCE = "api";
    const result = await selectOracleQuote({
      market,
      apiClient: {
        async fetchMarketPrice() {
          return { priceUsd: 99, productConditionId: 123, conditionId: 1, languageId: 1 };
        }
      },
      browserState: {},
      poketracePrices: {
        "CHARIZARD-X": {
          source: "poketrace-ewap",
          priceUsd: 101,
          observedAt: now
        }
      },
      now
    });

    expect(result.selectedQuote.source).to.equal("tcgplayer-api");
    expect(result.selectedQuote.priceUsd).to.equal(99);
    expect(result.secondaryQuote.source).to.equal("poketrace-ewap");
  });

  it("can restore PokeTrace-first source order explicitly", async function () {
    process.env.ORACLE_PRIMARY_SOURCE = "poketrace";
    process.env.ORACLE_TCGPLAYER_SOURCE = "api";
    const result = await selectOracleQuote({
      market,
      apiClient: {
        async fetchMarketPrice() {
          return { priceUsd: 99, productConditionId: 123, conditionId: 1, languageId: 1 };
        }
      },
      browserState: {},
      poketracePrices: {
        "CHARIZARD-X": {
          source: "poketrace-aggregate",
          priceUsd: 102,
          observedAt: now
        }
      },
      now
    });

    expect(result.selectedQuote.source).to.equal("poketrace-aggregate");
    expect(result.selectedQuote.priceUsd).to.equal(102);
    expect(result.secondaryQuote.source).to.equal("tcgplayer-api");
  });

  it("uses TCGPlayer API when no corroborating quote is available", async function () {
    process.env.ORACLE_TCGPLAYER_SOURCE = "api";
    const result = await selectOracleQuote({
      market,
      apiClient: {
        async fetchMarketPrice() {
          return { priceUsd: 99, productConditionId: 123, conditionId: 1, languageId: 1 };
        }
      },
      browserState: {},
      poketracePrices: {},
      now
    });

    expect(result.selectedQuote.source).to.equal("tcgplayer-api");
    expect(result.selectedQuote.priceUsd).to.equal(99);
    expect(result.secondaryQuote).to.equal(null);
  });

  it("uses snapshot only after secondary pricing fails for an approved snapshot market", async function () {
    process.env.ORACLE_TCGPLAYER_SOURCE = "api";
    const result = await selectOracleQuote({
      market: {
        priceKey: "HL500-001",
        tcgplayerId: null,
        seedPriceUsd: 12.34,
        poketraceEligible: false,
        snapshotOnly: true
      },
      apiClient: null,
      browserState: {},
      poketracePrices: {},
      now
    });

    expect(result.selectedQuote.source).to.equal("snapshot");
    expect(result.selectedQuote.priceUsd).to.equal(12.34);
    expect(result.secondaryQuote).to.equal(null);
  });

  it("enables permitted Playwright pricing without source API keys", function () {
    process.env.ORACLE_TCGPLAYER_SOURCE = "playwright";
    process.env.ORACLE_REQUIRE_AUTHENTICATED_SOURCES = "true";
    expect(allowPlaywrightFallback()).to.equal(true);

    process.env.ORACLE_PLAYWRIGHT_ENABLED = "false";
    expect(allowPlaywrightFallback()).to.equal(false);
  });

  it("counts a corroborating source and rejects a divergent secondary from quorum", function () {
    process.env.ORACLE_MAX_SOURCE_DEVIATION_BPS = "3000";
    const selected = { source: "poketrace-ewap", priceUsd: 100 };
    expect(crossSourceStatus(selected, { source: "tcgplayer-api", priceUsd: 105 })).to.include({
      status: "confirmed",
      acceptedSources: 2
    });
    expect(crossSourceStatus(selected, { source: "tcgplayer-api", priceUsd: 150 })).to.include({
      status: "secondary-outlier",
      acceptedSources: 1
    });
    expect(isQuoteAccepted({ independentSourceCount: 1 }, 2)).to.equal(false);
    expect(isQuoteAccepted({ independentSourceCount: 2 }, 2)).to.equal(true);
  });

  it("bounds concurrent product-page work while preserving result order", async function () {
    let active = 0;
    let maximumActive = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 10;
    });

    expect(maximumActive).to.equal(2);
    expect(result).to.deep.equal([10, 20, 30, 40, 50, 60]);
  });

  it("exposes an HL300 seed sum as indicative until every constituent has a real price", function () {
    const list = require("../data/oracle/hl300-constituents.json");
    const quote = buildIndexQuote({
      index: { indexMarket: { priceApiMarket: "HL300" }, list },
      prices: {},
      previousQuote: null,
      priceFloors: { defaultFloorUsd: 0, markets: {} },
      now
    });

    expect(quote.price).to.be.greaterThan(0);
    expect(quote.lastUpdateTime).to.equal(now);
    expect(quote.source).to.equal("hoodliquid-hl300-seed");
    expect(quote.indicative).to.equal(true);
    expect(quote.tradable).to.equal(false);
    expect(quote.liveConstituentCount).to.equal(0);
    expect(confidenceBps(quote.source)).to.equal(0);
    expect(isQuoteAccepted(quote, 1)).to.equal(false);
  });
});
