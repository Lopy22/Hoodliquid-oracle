const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: ".env.local", quiet: true });
require("dotenv").config({ quiet: true });

const DEFAULT_PL500_PATH = "data/oracle/pl500-constituents.json";
const DEFAULT_REPORT_PATH = "data/oracle/pl500-resolution-report.json";
const DEFAULT_BASE_URL = "https://api.tcgplayer.com";
const DEFAULT_POKEMON_CATEGORY_ID = 3;
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_MIN_SCORE = 72;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const token = process.env.TCGPLAYER_BEARER_TOKEN || (await fetchTcgplayerBearerToken());
  if (!token) throw new Error("Missing TCGPlayer credentials; set TCGPLAYER_BEARER_TOKEN or TCGPLAYER_PUBLIC_KEY / TCGPLAYER_PRIVATE_KEY");

  const pl500Path = resolvePath(process.env.ORACLE_PL500_CONSTITUENTS || DEFAULT_PL500_PATH);
  const pl500 = JSON.parse(fs.readFileSync(pl500Path, "utf8"));
  const rows = Array.isArray(pl500.constituents) ? pl500.constituents : [];
  const selectedRows = rows
    .filter((row) => options.force || !Number(row.tcgplayerId || 0))
    .slice(options.offset, options.limit > 0 ? options.offset + options.limit : undefined);
  const client = createTcgplayerCatalogClient({ token });
  const results = [];
  const updatedRows = [...rows];

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
        sourceLabel: "tcgplayer-catalog-search",
        resolvedAt: Math.floor(Date.now() / 1000)
      };
    }
    await delay(options.delayMs);
  }

  const report = {
    version: 1,
    generatedAt: Math.floor(Date.now() / 1000),
    write: options.write,
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
      ...pl500,
      constituents: updatedRows
    };
    writeJsonAtomic(pl500Path, next);
  }

  console.log(
    `PL500 resolver ${options.write ? "wrote" : "dry-run"}: ${report.matched} matched, ${report.needsReview} review, ${report.unresolved} unresolved`
  );
  console.log(`Report: ${resolvePath(options.reportPath)}`);
}

function parseArgs(args) {
  return {
    write: args.includes("--write"),
    force: args.includes("--force"),
    limit: numberArg(args, "--limit", 0),
    offset: numberArg(args, "--offset", 0),
    minScore: numberArg(args, "--min-score", DEFAULT_MIN_SCORE),
    delayMs: numberArg(args, "--delay-ms", 250),
    reportPath: stringArg(args, "--report", DEFAULT_REPORT_PATH)
  };
}

async function resolveConstituent(row, client, options) {
  const candidates = await client.searchProducts(row);
  const scored = candidates
    .map((product) => ({ product, score: scoreProductMatch(row, product) }))
    .sort((left, right) => right.score - left.score);
  const best = scored[0] || null;
  if (!best) {
    return { id: row.id, card: row.card, set: row.set, status: "unresolved", candidates: [] };
  }

  const summary = scored.slice(0, 5).map(({ product, score }) => ({ score, product }));
  return {
    id: row.id,
    sourceNumber: row.sourceNumber,
    card: row.card,
    set: row.set,
    seedPriceUsd: row.seedPriceUsd,
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
  const numberScore = cardNumber(row.card) && normalizeText(product.name).includes(normalizeText(cardNumber(row.card))) ? 8 : 0;
  const sealedPenalty = /\b(booster|box|pack|bundle|etb|elite trainer|case)\b/i.test(product.name || "") ? 18 : 0;
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
    .filter((token) => !["the", "and", "with", "full", "art", "alternate", "secret", "rare"].includes(token));
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
  extractProductIds,
  normalizeProduct,
  scoreProductMatch,
  searchTerms,
  stripCardDecorators,
  tokenOverlapScore
};
