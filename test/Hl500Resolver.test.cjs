const { expect } = require("chai");
const {
  applyReviewedMappings,
  classifyPublicSearchState,
  extractProductIds,
  normalizePlaywrightProduct,
  scoreProductMatch,
  searchTerms,
  selectConstituentRows,
  selectResolverSource,
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

  it("does not mistake the Secret Box card for sealed product packaging", function () {
    const row = { card: "Secret Box", set: "SV06: Twilight Masquerade" };
    const card = {
      productId: 550207,
      name: "Secret Box",
      groupName: "SV06: Twilight Masquerade",
      rarity: "ACE SPEC Rare, #163/167"
    };
    const sealed = {
      productId: 543845,
      name: "Twilight Masquerade Elite Trainer Box",
      groupName: "SV06: Twilight Masquerade"
    };
    expect(scoreProductMatch(row, card)).to.be.greaterThanOrEqual(90);
    expect(scoreProductMatch(row, sealed)).to.be.lessThan(90);
  });

  it("normalizes common TCGPlayer search response product IDs", function () {
    expect(extractProductIds({ results: [1, { productId: 2 }, { id: 3 }] })).to.deep.equal([1, 2, 3]);
  });

  it("strips card-number decorators for broader search fallback", function () {
    expect(stripCardDecorators("Mega Charizard X ex - 125/094")).to.equal("Mega Charizard X ex");
    expect(tokenOverlapScore("Mega Charizard X ex", "Mega Charizard X ex - 125/094")).to.equal(100);
  });

  it("normalizes structured public-search product cards", function () {
    expect(
      normalizePlaywrightProduct({
        href: "/product/89171/pokemon-neo-destiny-shining-tyranitar?page=1",
        title: "Shining Tyranitar",
        imageAlt: "Shining Tyranitar",
        setName: "Neo Destiny",
        rarity: "Secret Rare, #113/105",
        marketPrice: "$4,249.99"
      })
    ).to.deep.include({
      productId: 89171,
      name: "Shining Tyranitar",
      groupName: "Neo Destiny",
      rarity: "Secret Rare, #113/105",
      marketPrice: "$4,249.99"
    });
    expect(normalizePlaywrightProduct({ href: "/search/pokemon/product" })).to.equal(null);
  });

  it("uses API credentials in auto mode and permission-gates public search", function () {
    expect(selectResolverSource({ requested: "auto", hasApiCredentials: true })).to.equal("api");
    expect(
      selectResolverSource({ requested: "auto", hasApiCredentials: false, scrapingPermissionConfirmed: true })
    ).to.equal("playwright");
    expect(() => selectResolverSource({ requested: "playwright", scrapingPermissionConfirmed: false })).to.throw(
      "ORACLE_TCGPLAYER_SCRAPING_PERMISSION_CONFIRMED=true"
    );
  });

  it("keeps batch offsets stable after earlier rows are mapped", function () {
    const rows = [
      { id: "HL500-001", tcgplayerId: 1 },
      { id: "HL500-002", tcgplayerId: null },
      { id: "HL500-003", tcgplayerId: null },
      { id: "HL500-004", tcgplayerId: null }
    ];
    expect(selectConstituentRows(rows, { offset: 2, limit: 2, force: false }).map((row) => row.id)).to.deep.equal([
      "HL500-003",
      "HL500-004"
    ]);
  });

  it("does not treat hidden challenge wording as blocked when products are present", function () {
    expect(
      classifyPublicSearchState({
        productCount: 12,
        bodyText: "Our support article mentions CAPTCHA handling."
      })
    ).to.deep.equal({ blocked: false, reason: null });
    expect(
      classifyPublicSearchState({ productCount: 0, visibleChallengeSelector: ".cf-turnstile" })
    ).to.deep.equal({ blocked: true, reason: "visible .cf-turnstile" });
  });

  it("applies a reviewed dry-run result without searching again", function () {
    const hl500 = {
      constituents: [{ id: "HL500-021", card: "Test Card", set: "Test Set", tcgplayerId: null }]
    };
    const report = {
      source: "playwright",
      minScore: 72,
      scanned: 1,
      matched: 1,
      needsReview: 0,
      unresolved: 0,
      results: [
        {
          id: "HL500-021",
          card: "Test Card",
          set: "Test Set",
          status: "matched",
          score: 95,
          product: { productId: 12345 }
        }
      ]
    };
    const applied = applyReviewedMappings(hl500, report);
    expect(applied.applied).to.equal(1);
    expect(applied.hl500.constituents[0]).to.include({
      tcgplayerId: 12345,
      sourceLabel: "tcgplayer-public-search-reviewed"
    });
  });

  it("refuses duplicate product identities from a reviewed report", function () {
    const hl500 = {
      constituents: [
        { id: "HL500-001", card: "Existing", set: "Set", tcgplayerId: 12345 },
        { id: "HL500-021", card: "Test Card", set: "Test Set", tcgplayerId: null }
      ]
    };
    const report = {
      minScore: 72,
      scanned: 1,
      matched: 1,
      needsReview: 0,
      unresolved: 0,
      results: [
        {
          id: "HL500-021",
          card: "Test Card",
          set: "Test Set",
          status: "matched",
          score: 95,
          product: { productId: 12345 }
        }
      ]
    };
    expect(() => applyReviewedMappings(hl500, report)).to.throw("already assigned to HL500-001");
  });

  it("preserves an exact duplicate source row as a separate equal-weight constituent", function () {
    const hl500 = {
      constituents: [
        {
          id: "HL500-188",
          card: "Koga's Beedrill",
          set: "Gym Challenge",
          seedPriceUsd: 130.29,
          tcgplayerId: 86505
        },
        {
          id: "HL500-189",
          card: "Koga's Beedrill",
          set: "Gym Challenge",
          seedPriceUsd: 130.29,
          tcgplayerId: null
        }
      ]
    };
    const report = {
      source: "playwright",
      minScore: 90,
      scanned: 1,
      matched: 1,
      needsReview: 0,
      unresolved: 0,
      results: [
        {
          id: "HL500-189",
          card: "Koga's Beedrill",
          set: "Gym Challenge",
          status: "matched",
          score: 92,
          product: { productId: 86505 }
        }
      ]
    };
    const applied = applyReviewedMappings(hl500, report, { automated: true });
    expect(applied.applied).to.equal(1);
    expect(applied.hl500.constituents[1]).to.include({
      tcgplayerId: 86505,
      duplicateOf: "HL500-188",
      sourceLabel: "tcgplayer-public-search-automated"
    });
  });

  it("labels guarded unattended mappings as automated rather than reviewed", function () {
    const hl500 = {
      constituents: [{ id: "HL500-181", card: "Automated Card", set: "Automated Set", tcgplayerId: null }]
    };
    const report = {
      source: "playwright",
      minScore: 90,
      scanned: 1,
      matched: 1,
      needsReview: 0,
      unresolved: 0,
      results: [
        {
          id: "HL500-181",
          card: "Automated Card",
          set: "Automated Set",
          status: "matched",
          score: 95,
          product: { productId: 54321 }
        }
      ]
    };
    const applied = applyReviewedMappings(hl500, report, { automated: true });
    expect(applied.hl500.constituents[0].sourceLabel).to.equal("tcgplayer-public-search-automated");
  });
});
