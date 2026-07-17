const { expect } = require("chai");
const {
  assertPlaywrightPermission,
  validateSourceConfiguration
} = require("../scripts/scrape-tcgplayer-prices.cjs");

describe("TCGPlayer Playwright permission gate", function () {
  const original = {};
  const keys = [
    "ORACLE_TCGPLAYER_SOURCE",
    "ORACLE_TCGPLAYER_SCRAPING_PERMISSION_CONFIRMED",
    "ORACLE_PLAYWRIGHT_ENABLED",
    "ORACLE_PLAYWRIGHT_FALLBACK"
  ];

  before(function () {
    for (const key of keys) original[key] = process.env[key];
  });

  afterEach(function () {
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it("blocks Playwright collection without explicit operator confirmation", function () {
    process.env.ORACLE_TCGPLAYER_SOURCE = "playwright";
    delete process.env.ORACLE_TCGPLAYER_SCRAPING_PERMISSION_CONFIRMED;
    expect(() => assertPlaywrightPermission()).to.throw(
      "requires express permission from TCGPlayer"
    );
  });

  it("accepts the explicit confirmation", function () {
    process.env.ORACLE_TCGPLAYER_SOURCE = "playwright";
    process.env.ORACLE_TCGPLAYER_SCRAPING_PERMISSION_CONFIRMED = "true";
    expect(validateSourceConfiguration()).to.equal(true);
  });

  it("does not require a scraping acknowledgement in API-only mode", function () {
    process.env.ORACLE_TCGPLAYER_SOURCE = "api";
    delete process.env.ORACLE_TCGPLAYER_SCRAPING_PERMISSION_CONFIRMED;
    expect(validateSourceConfiguration()).to.equal(true);
  });
});
