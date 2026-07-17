const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: ".env.local", quiet: true });
require("dotenv").config({ quiet: true });

const DEFAULT_HL500_PATH = "data/oracle/hl500-constituents.json";
const DEFAULT_REPORT_PATH = "data/oracle/hl500-resolution-report.json";
const DEFAULT_BASE_URL = "https://api.tcgplayer.com";
const DEFAULT_WEB_BASE_URL = "https://www.tcgplayer.com";
const DEFAULT_POKEMON_CATEGORY_ID = 3;
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_MIN_SCORE = 72;
const DEFAULT_PLAYWRIGHT_DELAY_MS = 3_000;
const RESOLVER_SOURCES = new Set(["auto", "api", "playwright"]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.applyReportPath) {
    applyReviewedReport(options);
    return;
  }
  const hasApiCredentials = Boolean(
    process.env.TCGPLAYER_BEARER_TOKEN || (process.env.TCGPLAYER_PUBLIC_KEY && process.env.TCGPLAYER_PRIVATE_KEY)
  );
  const source = selectResolverSource({
    requested: options.source,
    hasApiCredentials,
    scrapingPermissionConfirmed: process.env.ORACLE_TCGPLAYER_SCRAPING_PERMISSION_CONFIRMED === "true"
  });
  let token = null;
  if (source === "api") {
    token = process.env.TCGPLAYER_BEARER_TOKEN || (await fetchTcgplayerBearerToken());
    if (!token) {
      throw new Error(
        "Missing TCGPlayer credentials; set TCGPLAYER_BEARER_TOKEN or TCGPLAYER_PUBLIC_KEY / TCGPLAYER_PRIVATE_KEY, or use --source=playwright with explicit collection permission"
      );
    }
  }

  const hl500Path = resolvePath(process.env.ORACLE_HL500_CONSTITUENTS || DEFAULT_HL500_PATH);
  const hl500 = JSON.parse(fs.readFileSync(hl500Path, "utf8"));
  const rows = Array.isArray(hl500.constituents) ? hl500.constituents : [];
  const selectedRows = selectConstituentRows(rows, options);
  const client =
    source === "api"
      ? createTcgplayerCatalogClient({ token })
      : await createTcgplayerCatalogPlaywrightClient({ minScore: options.minScore });
  const results = [];
  const updatedRows = [...rows];

  try {
    for (const row of selectedRows) {
      const resolution = await resolveConstituent(row, client, options);
      results.push(resolution);
      if (options.write && resolution.status === "matched") {
        const index = updatedRows.findIndex((candidate) => candidate.id === row.id);
        updatedRows[index] = {
          ...updatedRows[index],
          tcgplayerId: resolution.product.productId,
          tcgplayerUrl: `https://www.tcgplayer.com/product/${resolution.product.productId}?page=1&Language=English`,
          conditionName: "Near Mint",
          conditionId: 1,
          language: "English",
          languageId: 1,
          sourceLabel: source === "api" ? "tcgplayer-catalog-search-reviewed" : "tcgplayer-public-search-reviewed",
          resolvedAt: Math.floor(Date.now() / 1000)
        };
      }
      await delay(options.delayMs);
    }
  } finally {
    await client.close?.();
  }

  const report = {
    version: 1,
    generatedAt: Math.floor(Date.now() / 1000),
    write: options.write,
    reviewed: options.reviewed,
    source,
    offset: options.offset,
    limit: options.limit,
    minScore: options.minScore,
    scanned: selectedRows.length,
    matched: results.filter((result) => result.status === "matched").length,
    needsReview: results.filter((result) => result.status === "needs-review").length,
    unresolved: results.filter((result) => result.status === "unresolved").length,
    results
  };
  writeJsonAtomic(resolvePath(options.reportPath), report);

  if (options.write) {
    const next = {
      ...hl500,
      constituents: updatedRows
    };
    writeJsonAtomic(hl500Path, next);
  }

  console.log(
    `HL500 resolver ${options.write ? "wrote" : "dry-run"}: ${report.matched} matched, ${report.needsReview} review, ${report.unresolved} unresolved`
  );
  console.log(`Report: ${resolvePath(options.reportPath)}`);
}

function parseArgs(args) {
  const source = stringArg(args, "--source", process.env.ORACLE_HL500_RESOLVER_SOURCE || "auto").toLowerCase();
  if (!RESOLVER_SOURCES.has(source)) {
    throw new Error(`Invalid HL500 resolver source ${source}; expected auto, api, or playwright`);
  }
  const write = args.includes("--write");
  const reviewed = args.includes("--reviewed");
  const automated = args.includes("--automated");
  const applyReportPath = stringArg(args, "--apply-report", "");
  if (write && !reviewed && !automated) {
    throw new Error(
      "Refusing to write HL500 mappings without an explicit mode; add --reviewed after manual review or --automated for guarded unattended application"
    );
  }
  if (automated && !applyReportPath) {
    throw new Error("--automated is valid only with --apply-report so guarded results are applied without a second source request");
  }
  return {
    write,
    reviewed,
    automated,
    force: args.includes("--force"),
    source,
    limit: numberArg(args, "--limit", 0),
    offset: numberArg(args, "--offset", 0),
    minScore: numberArg(args, "--min-score", DEFAULT_MIN_SCORE),
    delayMs: numberArg(
      args,
      "--delay-ms",
      positiveNumber(process.env.TCGPLAYER_RESOLVER_DELAY_MS, DEFAULT_PLAYWRIGHT_DELAY_MS)
    ),
    reportPath: stringArg(args, "--report", DEFAULT_REPORT_PATH),
    applyReportPath
  };
}

function applyReviewedReport(options) {
  if (!options.write || (!options.reviewed && !options.automated)) {
    throw new Error("Applying an HL500 report requires --write with either --reviewed or --automated");
  }
  const reportPath = resolvePath(options.applyReportPath);
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (report.write !== false || report.reviewed !== false) {
    throw new Error("Only an unchanged dry-run HL500 report can be applied");
  }
  const hl500Path = resolvePath(process.env.ORACLE_HL500_CONSTITUENTS || DEFAULT_HL500_PATH);
  const hl500 = JSON.parse(fs.readFileSync(hl500Path, "utf8"));
  const applied = applyReviewedMappings(hl500, report, { force: options.force, automated: options.automated });
  writeJsonAtomic(hl500Path, applied.hl500);
  console.log(
    `HL500 applied ${options.automated ? "guarded automated" : "reviewed"} report: ${applied.applied} mappings written, ${applied.unchanged} already present`
  );
  console.log(`Report: ${reportPath}`);
}

function applyReviewedMappings(hl500, report, { force = false, automated = false } = {}) {
  const rows = Array.isArray(hl500?.constituents) ? hl500.constituents : [];
  const results = Array.isArray(report?.results) ? report.results : [];
  const issues = results.filter((result) => result.status !== "matched");
  if (issues.length > 0 || Number(report?.needsReview || 0) > 0 || Number(report?.unresolved || 0) > 0) {
    throw new Error("The reviewed report contains needs-review or unresolved rows; resolve them before applying this batch");
  }
  if (results.length !== Number(report?.scanned || 0) || results.length !== Number(report?.matched || 0)) {
    throw new Error("The reviewed report counts do not match its result rows");
  }

  const updatedRows = rows.map((row) => ({ ...row }));
  let applied = 0;
  let unchanged = 0;
  for (const result of results) {
    const index = updatedRows.findIndex((row) => row.id === result.id);
    if (index < 0) throw new Error(`Reviewed report contains unknown constituent ${result.id}`);
    const row = updatedRows[index];
    if (String(row.card) !== String(result.card) || String(row.set) !== String(result.set)) {
      throw new Error(`Reviewed report identity mismatch for ${result.id}`);
    }
    const productId = Number(result?.product?.productId || 0);
    if (!Number.isInteger(productId) || productId <= 0) {
      throw new Error(`Reviewed report has an invalid TCGPlayer product for ${result.id}`);
    }
    if (Number(result.score || 0) < Number(report.minScore || DEFAULT_MIN_SCORE)) {
      throw new Error(`Reviewed report score is below its threshold for ${result.id}`);
    }
    const duplicate = updatedRows.find((candidate, candidateIndex) =>
      candidateIndex !== index && candidate.snapshotOnly !== true && Number(candidate.tcgplayerId || 0) === productId
    );
    const exactDuplicate = duplicate && sameConstituentIdentity(row, duplicate);
    if (duplicate && !exactDuplicate) {
      throw new Error(`TCGPlayer product ${productId} is already assigned to ${duplicate.id}; refusing duplicate ${result.id}`);
    }
    if (Number(row.tcgplayerId || 0) > 0 && Number(row.tcgplayerId) !== productId && !force) {
      throw new Error(`${result.id} already has a different TCGPlayer product; use --force only after reviewing the replacement`);
    }
    if (Number(row.tcgplayerId || 0) === productId) {
      unchanged += 1;
      continue;
    }
    updatedRows[index] = {
      ...row,
      tcgplayerId: productId,
      tcgplayerUrl: `https://www.tcgplayer.com/product/${productId}?page=1&Language=English`,
      conditionName: "Near Mint",
      conditionId: 1,
      language: "English",
      languageId: 1,
      sourceLabel:
        report.source === "api"
          ? automated
            ? "tcgplayer-catalog-search-automated"
            : "tcgplayer-catalog-search-reviewed"
          : automated
            ? "tcgplayer-public-search-automated"
            : "tcgplayer-public-search-reviewed",
      ...(exactDuplicate ? { duplicateOf: duplicate.id } : {}),
      resolvedAt: Math.floor(Date.now() / 1000)
    };
    applied += 1;
  }
  return { hl500: { ...hl500, constituents: updatedRows }, applied, unchanged };
}

function sameConstituentIdentity(left, right) {
  return (
    normalizeText(left?.card) === normalizeText(right?.card) &&
    normalizeText(left?.set) === normalizeText(right?.set) &&
    Number(left?.seedPriceUsd || 0) === Number(right?.seedPriceUsd || 0)
  );
}

function selectConstituentRows(rows, options) {
  const offset = Math.max(0, Number(options.offset || 0));
  const end = Number(options.limit || 0) > 0 ? offset + Number(options.limit) : undefined;
  return rows.slice(offset, end).filter((row) => options.force || !Number(row.tcgplayerId || 0));
}

async function resolveConstituent(row, client, options) {
  const candidates = await client.searchProducts(row);
  const scored = candidates
    .map((product) => ({ product, score: scoreProductMatch(row, product) }))
    .sort((left, right) => right.score - left.score);
  const best = scored[0] || null;
  if (!best) {
    return { id: row.id, card: row.card, set: row.set, source: client.source, status: "unresolved", candidates: [] };
  }

  const summary = scored.slice(0, 5).map(({ product, score }) => ({ score, product }));
  return {
    id: row.id,
    sourceNumber: row.sourceNumber,
    card: row.card,
    set: row.set,
    seedPriceUsd: row.seedPriceUsd,
    source: client.source,
    status: best.score >= options.minScore ? "matched" : "needs-review",
    score: best.score,
    product: best.product,
    candidates: summary
  };
}

function createTcgplayerCatalogClient({ token, baseUrl = process.env.TCGPLAYER_API_BASE_URL || DEFAULT_BASE_URL }) {
  const categoryId = Number(process.env.TCGPLAYER_POKEMON_CATEGORY_ID || DEFAULT_POKEMON_CATEGORY_ID);
  const searchLimit = Number(process.env.TCGPLAYER_SEARCH_LIMIT || DEFAULT_SEARCH_LIMIT);
  return {
    source: "api",
    async searchProducts(row) {
      const seen = new Set();
      const products = [];
      for (const term of searchTerms(row)) {
        const ids = await searchProductIds({ term, token, baseUrl, categoryId, searchLimit });
        const freshIds = ids.filter((id) => !seen.has(id)).slice(0, searchLimit);
        freshIds.forEach((id) => seen.add(id));
        if (freshIds.length === 0) continue;
        products.push(...(await fetchProducts({ ids: freshIds, token, baseUrl })));
      }
      return products;
    }
  };
}

async function createTcgplayerCatalogPlaywrightClient({
  baseUrl = process.env.TCGPLAYER_WEB_BASE_URL || DEFAULT_WEB_BASE_URL,
  minScore = DEFAULT_MIN_SCORE
} = {}) {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (error) {
    throw new Error(`Playwright is required for the credential-free resolver; run npm ci and npx playwright install chromium (${error.message})`);
  }

  const browser = await chromium.launch({ headless: process.env.ORACLE_HEADLESS !== "false" });
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  const timeoutMs = positiveNumber(process.env.TCGPLAYER_SEARCH_TIMEOUT_MS, 45_000);
  const searchLimit = positiveNumber(process.env.TCGPLAYER_SEARCH_LIMIT, DEFAULT_SEARCH_LIMIT);
  const fallbackDelayMs = positiveNumber(process.env.TCGPLAYER_SEARCH_DELAY_MS, 750);

  return {
    source: "playwright",
    async searchProducts(row) {
      const seen = new Set();
      const products = [];
      const terms = searchTerms(row);
      for (let index = 0; index < terms.length; index += 1) {
        const term = terms[index];
        const url = new URL("/search/pokemon/product", baseUrl);
        url.searchParams.set("q", term);
        url.searchParams.set("productLineName", "pokemon");
        url.searchParams.set("view", "grid");
        await page.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await waitForPublicSearch(page, timeoutMs);
        const entries = await extractPlaywrightEntries(page);
        for (const entry of entries) {
          const product = normalizePlaywrightProduct(entry, baseUrl);
          if (!product || seen.has(product.productId)) continue;
          seen.add(product.productId);
          products.push(product);
          if (products.length >= searchLimit) break;
        }
        if (products.some((product) => scoreProductMatch(row, product) >= minScore) || products.length >= searchLimit) break;
        if (index < terms.length - 1) await delay(fallbackDelayMs);
      }
      return products;
    },
    async close() {
      await context.close();
      await browser.close();
    }
  };
}

async function waitForPublicSearch(page, timeoutMs) {
  await page.waitForFunction(
    () => {
      const text = document.body?.innerText || "";
      const hasNumericProductLink = Array.from(document.querySelectorAll('a[href*="/product/"]')).some((anchor) =>
        /\/product\/\d+(?:\/|\?|$)/i.test(anchor.getAttribute("href") || "")
      );
      const challengeSelectors = [
        'iframe[src*="challenges.cloudflare.com"]',
        'iframe[src*="recaptcha"]',
        'iframe[src*="hcaptcha"]',
        'input[name="cf-turnstile-response"]',
        ".cf-turnstile",
        ".g-recaptcha",
        ".h-captcha",
        "#challenge-running",
        "#challenge-stage"
      ];
      const visibleChallenge = challengeSelectors.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
        })
      );
      return Boolean(
        hasNumericProductLink ||
          visibleChallenge ||
          /verify you are human|access denied|unusual traffic/i.test(`${document.title}\n${text.slice(0, 4_000)}`)
      );
    },
    { timeout: timeoutMs }
  );
  const signals = await page.evaluate(() => {
    const challengeSelectors = [
      'iframe[src*="challenges.cloudflare.com"]',
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      'input[name="cf-turnstile-response"]',
      ".cf-turnstile",
      ".g-recaptcha",
      ".h-captcha",
      "#challenge-running",
      "#challenge-stage"
    ];
    const visibleChallengeSelector =
      challengeSelectors.find((selector) =>
        Array.from(document.querySelectorAll(selector)).some((element) => {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) !== 0 && rect.width > 0 && rect.height > 0;
        })
      ) || null;
    const productCount = Array.from(document.querySelectorAll('a[href*="/product/"]')).filter((anchor) =>
      /\/product\/\d+(?:\/|\?|$)/i.test(anchor.getAttribute("href") || "")
    ).length;
    return {
      productCount,
      visibleChallengeSelector,
      title: document.title,
      bodyText: (document.body?.innerText || "").slice(0, 4_000),
      url: window.location.href
    };
  });
  const state = classifyPublicSearchState(signals);
  if (state.blocked) {
    throw new Error(
      `TCGPlayer public search presented bot protection or a CAPTCHA (${state.reason}) at ${signals.url}; resolver stopped without attempting a bypass`
    );
  }
}

function classifyPublicSearchState({ productCount = 0, visibleChallengeSelector = null, title = "", bodyText = "" } = {}) {
  if (visibleChallengeSelector) return { blocked: true, reason: `visible ${visibleChallengeSelector}` };
  if (Number(productCount) > 0) return { blocked: false, reason: null };
  const text = `${title}\n${String(bodyText).slice(0, 4_000)}`;
  const match = text.match(/captcha|verify you are human|access denied|unusual traffic|automated access/i);
  return match ? { blocked: true, reason: `page text: ${match[0]}` } : { blocked: false, reason: null };
}

async function extractPlaywrightEntries(page) {
  return page.locator('a[href*="/product/"]').evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: anchor.getAttribute("href") || "",
      title: anchor.querySelector(".product-card__title")?.textContent?.trim() || "",
      imageAlt: anchor.querySelector("img[alt]")?.getAttribute("alt")?.trim() || "",
      setName:
        anchor.querySelector(".product-card__set-name__variant")?.textContent?.trim() ||
        anchor.querySelector(".product-card__set-name")?.textContent?.trim() ||
        "",
      rarity:
        anchor.querySelector(".product-card__rarity__variant")?.textContent?.trim() ||
        anchor.querySelector(".product-card__rarity")?.textContent?.trim() ||
        "",
      marketPrice: anchor.querySelector(".product-card__market-price--value")?.textContent?.trim() || ""
    }))
  );
}

function normalizePlaywrightProduct(entry, baseUrl = DEFAULT_WEB_BASE_URL) {
  const match = String(entry?.href || "").match(/\/product\/(\d+)(?:\/|\?|$)/i);
  if (!match) return null;
  let productUrl = null;
  try {
    productUrl = new URL(entry.href, baseUrl).toString();
  } catch (_) {
    productUrl = null;
  }
  return {
    productId: Number(match[1]),
    name: String(entry.title || entry.imageAlt || "").trim(),
    cleanName: String(entry.imageAlt || entry.title || "").trim(),
    groupId: null,
    groupName: String(entry.setName || "").trim(),
    categoryName: "Pokemon",
    rarity: String(entry.rarity || "").trim(),
    marketPrice: String(entry.marketPrice || "").trim() || null,
    productUrl
  };
}

function selectResolverSource({ requested = "auto", hasApiCredentials = false, scrapingPermissionConfirmed = false } = {}) {
  const source = String(requested || "auto").toLowerCase();
  if (!RESOLVER_SOURCES.has(source)) {
    throw new Error(`Invalid HL500 resolver source ${source}; expected auto, api, or playwright`);
  }
  const selected = source === "auto" ? (hasApiCredentials ? "api" : "playwright") : source;
  if (selected === "playwright" && !scrapingPermissionConfirmed) {
    throw new Error(
      "Credential-free TCGPlayer public search requires ORACLE_TCGPLAYER_SCRAPING_PERMISSION_CONFIRMED=true. Set it only after confirming you have permission to collect these pages."
    );
  }
  return selected;
}

async function searchProductIds({ term, token, baseUrl, categoryId, searchLimit }) {
  const filterName = process.env.TCGPLAYER_SEARCH_FILTER_NAME || "ProductName";
  const payload = await fetchTcgplayerJson(`${baseUrl}/catalog/categories/${categoryId}/search`, token, "catalog search", {
    method: "POST",
    body: JSON.stringify({
      sort: "Relevance",
      limit: searchLimit,
      offset: 0,
      filters: [{ name: filterName, values: [term] }]
    })
  });
  return extractProductIds(payload).slice(0, searchLimit);
}

async function fetchProducts({ ids, token, baseUrl }) {
  const payload = await fetchTcgplayerJson(`${baseUrl}/catalog/products/${ids.join(",")}`, token, "product detail");
  return resultArray(payload).map(normalizeProduct).filter((product) => product.productId > 0);
}

async function fetchTcgplayerJson(url, token, label, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "content-type": "application/json"
    },
    body: options.body
  });
  if (!response.ok) throw new Error(`TCGPlayer ${label} API ${response.status}`);
  return response.json();
}

async function fetchTcgplayerBearerToken() {
  if (!process.env.TCGPLAYER_PUBLIC_KEY || !process.env.TCGPLAYER_PRIVATE_KEY) return null;
  const baseUrl = process.env.TCGPLAYER_API_BASE_URL || DEFAULT_BASE_URL;
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.TCGPLAYER_PUBLIC_KEY,
    client_secret: process.env.TCGPLAYER_PRIVATE_KEY
  });
  const response = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  if (!response.ok) throw new Error(`TCGPlayer token API ${response.status}`);
  const payload = await response.json();
  return payload.access_token;
}

function searchTerms(row) {
  return [
    `${row.card} ${row.set}`,
    stripCardDecorators(row.card),
    row.card
  ]
    .map((term) => String(term || "").trim())
    .filter(Boolean)
    .filter((term, index, list) => list.indexOf(term) === index);
}

function scoreProductMatch(row, product) {
  const nameScore = tokenOverlapScore(stripCardDecorators(row.card), product.name);
  const setScore = tokenOverlapScore(row.set, product.groupName || product.setName || product.categoryName || "");
  const exactName = normalizeText(stripCardDecorators(row.card)) === normalizeText(product.name);
  const numberScore =
    cardNumber(row.card) && normalizeText(`${product.name || ""} ${product.rarity || ""}`).includes(normalizeText(cardNumber(row.card))) ? 8 : 0;
  const sealedPenalty = !exactName && /\b(booster|box|pack|bundle|etb|elite trainer|case)\b/i.test(product.name || "") ? 18 : 0;
  return Math.max(0, Math.min(100, Math.round(nameScore * 0.68 + setScore * 0.24 + numberScore - sealedPenalty)));
}

function tokenOverlapScore(left, right) {
  const leftTokens = meaningfulTokens(left);
  const rightTokens = new Set(meaningfulTokens(right));
  if (leftTokens.length === 0 || rightTokens.size === 0) return 0;
  const matched = leftTokens.filter((token) => rightTokens.has(token)).length;
  return (matched / leftTokens.length) * 100;
}

function meaningfulTokens(value) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1)
    .filter((token) => !["the", "and", "with", "full", "art", "alternate"].includes(token));
}

function stripCardDecorators(value) {
  return String(value || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+-\s+\d+\/\d+.*/, " ")
    .trim();
}

function cardNumber(value) {
  const match = String(value || "").match(/\b\d{1,3}\/\d{1,3}\b/);
  return match ? match[0] : "";
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeProduct(entry) {
  return {
    productId: Number(entry.productId || entry.id || 0),
    name: String(entry.name || entry.productName || ""),
    cleanName: String(entry.cleanName || ""),
    groupId: Number(entry.groupId || 0) || null,
    groupName: String(entry.groupName || entry.setName || ""),
    categoryName: String(entry.categoryName || ""),
    imageUrl: entry.imageUrl || entry.image_url || null
  };
}

function extractProductIds(payload) {
  const values = [
    payload?.results,
    payload?.result,
    payload?.data,
    payload?.productIds,
    payload?.product_ids
  ]
    .filter(Boolean)
    .flat();
  return values
    .map((entry) => Number(typeof entry === "object" ? entry.productId || entry.id : entry))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function resultArray(payload) {
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.data)) return payload.data;
  if (payload?.result && typeof payload.result === "object") return [payload.result];
  return [];
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function numberArg(args, name, fallback) {
  const prefix = `${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix));
  return value ? Number(value.slice(prefix.length)) : fallback;
}

function stringArg(args, name, fallback) {
  const prefix = `${name}=`;
  const value = args.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function resolvePath(configured) {
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  applyReviewedMappings,
  classifyPublicSearchState,
  extractProductIds,
  normalizeProduct,
  normalizePlaywrightProduct,
  scoreProductMatch,
  searchTerms,
  selectConstituentRows,
  selectResolverSource,
  stripCardDecorators,
  tokenOverlapScore
};
