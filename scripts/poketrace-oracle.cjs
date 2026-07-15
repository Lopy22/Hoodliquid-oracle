const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DEFAULT_BASE_URL = "https://api.poketrace.com/v1";
const DEFAULT_MIN_COMPS = 5;
const DEFAULT_HALF_LIFE_DAYS = 7;
const DEFAULT_LISTING_LIMIT = 50;
const DEFAULT_AGGREGATE_TIER = "NEAR_MINT";

class PoketraceHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "PoketraceHttpError";
    this.status = status;
  }
}

function createPoketraceClient(options = {}) {
  const apiKey = options.apiKey || process.env.POKETRACE_API_KEY;
  if (!apiKey) return null;

  const baseUrl = options.baseUrl || process.env.POKETRACE_API_BASE_URL || DEFAULT_BASE_URL;
  const cachePath = options.cachePath || resolvePath(process.env.ORACLE_POKETRACE_CARD_CACHE || "data/oracle/poketrace-cards.json");
  const cardCache = readJson(cachePath) || { version: 1, products: {} };

  return {
    async fetchMarketPrice(market, now = Math.floor(Date.now() / 1000)) {
      const resolved = await resolveCard({ market, apiKey, baseUrl, cardCache });
      const detailPayload = await fetchJson(`${baseUrl}/cards/${encodeURIComponent(resolved.id)}`, apiKey, "card detail");
      const card = detailPayload?.data || resolved;
      const observedAt = parseTimestamp(card.lastUpdated || card.updatedAt || card.last_updated) || now;

      if (!useListingsEndpoint()) {
        const aggregate = computePoketraceAggregatePrice(card);
        return {
          priceUsd: aggregate.priceUsd,
          source: "poketrace-aggregate",
          observedAt,
          metadata: {
            poketraceId: card.id,
            poketraceUpdatedAt: observedAt,
            aggregateFallback: true,
            aggregateReason: "PokeTrace listings endpoint disabled for free-key mode",
            aggregateSource: aggregate.source,
            aggregateTier: aggregate.tier,
            aggregateSaleCount: aggregate.saleCount,
            aggregateApproxSaleCount: aggregate.approxSaleCount,
            listingsRequiredPlan: "Scale"
          }
        };
      }

      try {
        const listings = await fetchListings({ cardId: card.id, apiKey, baseUrl });
        const result = computePoketracePrice(listings, {
          now,
          minComps: Number(process.env.ORACLE_POKETRACE_MIN_COMPS || DEFAULT_MIN_COMPS),
          halfLifeDays: Number(process.env.ORACLE_POKETRACE_EWAP_HALF_LIFE_DAYS || DEFAULT_HALF_LIFE_DAYS)
        });

        return {
          priceUsd: result.anchoredEwap,
          source: "poketrace-ewap",
          observedAt,
          metadata: {
            poketraceId: card.id,
            poketraceUpdatedAt: observedAt,
            cleanMedian: result.cleanMedian,
            ewap: result.ewap,
            anchorLower: result.anchorLower,
            anchorUpper: result.anchorUpper,
            compCount: result.compCount,
            rejectedCompCount: result.rejectedCompCount,
            rejectionBreakdown: result.rejectionBreakdown,
            cleanCompHash: result.cleanCompHash,
            newestCompSoldAt: result.newestCompSoldAt,
            oldestCompSoldAt: result.oldestCompSoldAt,
            compWindowDays: result.compWindowDays,
            ewapHalfLifeDays: result.halfLifeDays
          }
        };
      } catch (error) {
        if (!allowAggregateFallback(error)) throw error;
        const aggregate = computePoketraceAggregatePrice(card);
        return {
          priceUsd: aggregate.priceUsd,
          source: "poketrace-aggregate",
          observedAt,
          metadata: {
            poketraceId: card.id,
            poketraceUpdatedAt: observedAt,
            aggregateFallback: true,
            aggregateReason: error instanceof Error ? error.message : String(error),
            aggregateSource: aggregate.source,
            aggregateTier: aggregate.tier,
            aggregateSaleCount: aggregate.saleCount,
            aggregateApproxSaleCount: aggregate.approxSaleCount,
            listingsRequiredPlan: "Scale"
          }
        };
      }
    },
    close() {
      writeJsonAtomic(cachePath, cardCache);
    }
  };
}

async function resolveCard({ market, apiKey, baseUrl, cardCache }) {
  const cacheKey = String(market.tcgplayerId || market.priceKey);
  const cached = cardCache.products[cacheKey];
  if (cached?.id) return cached;

  const search = market.poketraceSearch || [market.card, market.set].filter(Boolean).join(" ");
  if (!search) throw new Error(`No PokeTrace search identity for ${market.priceKey}`);
  const params = new URLSearchParams({ search, market: "US", limit: "20" });
  const payload = await fetchJson(`${baseUrl}/cards?${params}`, apiKey, "card resolver");
  const candidates = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : [];
  const expectedTcgplayerId = String(market.tcgplayerId || "");
  const exact = candidates.find((candidate) => String(candidate?.refs?.tcgplayerId || "") === expectedTcgplayerId);
  if (!exact) throw new Error(`PokeTrace could not resolve TCGPlayer product ${expectedTcgplayerId} for ${market.priceKey}`);

  const resolved = {
    id: exact.id,
    name: exact.name,
    cardNumber: exact.cardNumber,
    set: exact.set?.name,
    lastUpdated: exact.lastUpdated,
    tcgplayerId: expectedTcgplayerId,
    resolvedAt: Math.floor(Date.now() / 1000)
  };
  cardCache.products[cacheKey] = resolved;
  return resolved;
}

async function fetchListings({ cardId, apiKey, baseUrl }) {
  const params = new URLSearchParams({
    limit: String(Number(process.env.ORACLE_POKETRACE_LISTING_LIMIT || DEFAULT_LISTING_LIMIT)),
    sort: "sold_at_desc"
  });
  const payload = await fetchJson(`${baseUrl}/cards/${encodeURIComponent(cardId)}/listings?${params}`, apiKey, "sold listings");
  return Array.isArray(payload?.data) ? payload.data : [];
}

async function fetchJson(url, apiKey, label) {
  const response = await fetch(url, {
    headers: {
      "X-API-Key": apiKey,
      accept: "application/json"
    }
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new PoketraceHttpError(`PokeTrace ${label} API ${response.status}${errorBody ? `: ${errorBody.slice(0, 160)}` : ""}`, response.status);
  }
  return response.json();
}

function allowAggregateFallback(error) {
  if (process.env.ORACLE_POKETRACE_REQUIRE_LISTINGS === "true") return false;
  if (process.env.ORACLE_POKETRACE_AGGREGATE_FALLBACK === "false") return false;
  if (error instanceof PoketraceHttpError && [401, 404].includes(error.status)) return false;
  return true;
}

function useListingsEndpoint() {
  return process.env.ORACLE_POKETRACE_USE_LISTINGS !== "false";
}

function computePoketraceAggregatePrice(card, options = {}) {
  const tier = String(options.tier || process.env.ORACLE_POKETRACE_AGGREGATE_TIER || DEFAULT_AGGREGATE_TIER).toUpperCase();
  const sourceOrder = String(options.sourceOrder || process.env.ORACLE_POKETRACE_AGGREGATE_SOURCE_ORDER || "ebay,tcgplayer")
    .split(",")
    .map((source) => source.trim().toLowerCase())
    .filter(Boolean);

  for (const source of sourceOrder) {
    const bucket = card?.prices?.[source]?.[tier];
    const priceUsd = Number(bucket?.avg ?? bucket?.median7d ?? bucket?.median30d ?? bucket?.avg7d ?? bucket?.avg30d ?? 0);
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;
    return {
      priceUsd: roundUsd(priceUsd),
      source,
      tier,
      saleCount: normalizeOptionalNumber(bucket.saleCount),
      approxSaleCount: bucket.approxSaleCount === true
    };
  }

  throw new Error(`No PokeTrace aggregate ${tier} price found`);
}

function computePoketracePrice(listings, options = {}) {
  const now = Number(options.now || Math.floor(Date.now() / 1000));
  const minComps = Number(options.minComps || DEFAULT_MIN_COMPS);
  const halfLifeDays = Number(options.halfLifeDays || DEFAULT_HALF_LIFE_DAYS);
  const rejectionBreakdown = {
    invalid: 0,
    nonUsd: 0,
    anomalyFlag: 0,
    graded: 0,
    nonNearMint: 0,
    medianOutlier: 0
  };
  const normalized = [];

  for (const raw of listings) {
    const listing = normalizeListing(raw);
    const rejection = getPreMedianRejection(listing);
    if (rejection) {
      rejectionBreakdown[rejection] += 1;
      continue;
    }
    normalized.push(listing);
  }

  const anomalyFiltered = filterMedianOutliers(normalized);
  rejectionBreakdown.medianOutlier = normalized.length - anomalyFiltered.length;

  if (anomalyFiltered.length < minComps) {
    throw new Error(`only ${anomalyFiltered.length} clean Near Mint eBay comps; ${minComps} required`);
  }

  const prices = anomalyFiltered.map((listing) => listing.price);
  const cleanMedian = median(prices);
  const halfLifeSeconds = Math.max(1, halfLifeDays * 24 * 60 * 60);
  let weightedTotal = 0;
  let totalWeight = 0;
  for (const listing of anomalyFiltered) {
    const ageSeconds = Math.max(0, now - listing.soldAt);
    const weight = Math.pow(0.5, ageSeconds / halfLifeSeconds);
    weightedTotal += listing.price * weight;
    totalWeight += weight;
  }

  const ewap = weightedTotal / totalWeight;
  const anchorLower = cleanMedian * 0.85;
  const anchorUpper = cleanMedian * 1.15;
  const anchoredEwap = Math.max(anchorLower, Math.min(anchorUpper, ewap));
  const soldTimes = anomalyFiltered.map((listing) => listing.soldAt);
  const newestCompSoldAt = Math.max(...soldTimes);
  const oldestCompSoldAt = Math.min(...soldTimes);
  return {
    cleanMedian: roundUsd(cleanMedian),
    ewap: roundUsd(ewap),
    anchorLower: roundUsd(anchorLower),
    anchorUpper: roundUsd(anchorUpper),
    anchoredEwap: roundUsd(anchoredEwap),
    compCount: anomalyFiltered.length,
    rejectedCompCount: listings.length - anomalyFiltered.length,
    rejectionBreakdown,
    cleanCompHash: hashCleanComps(anomalyFiltered),
    newestCompSoldAt,
    oldestCompSoldAt,
    compWindowDays: roundUsd((newestCompSoldAt - oldestCompSoldAt) / (24 * 60 * 60)),
    halfLifeDays
  };
}

function normalizeListing(listing) {
  const price = normalizePrice(listing);
  const title = String(listing?.title || listing?.name || listing?.listingTitle || "");
  return {
    price: price.value,
    currency: price.currency,
    soldAt: parseTimestamp(listing?.soldAt || listing?.sold_at || listing?.soldDate || listing?.endedAt || listing?.endTime) || 0,
    condition: normalizeCondition(listing?.condition || listing?.conditionName),
    grader: listing?.grader ? String(listing.grader).toUpperCase() : null,
    grade: listing?.grade ? String(listing.grade) : null,
    anomalyFlag: listing?.anomalyFlag === true || listing?.isAnomaly === true || listing?.anomaly === true,
    title,
    id: String(listing?.id || listing?.listingId || listing?.itemId || "")
  };
}

function normalizePrice(listing) {
  const rawPrice = listing?.price ?? listing?.soldPrice ?? listing?.salePrice ?? listing?.totalPrice ?? listing?.amount;
  if (rawPrice && typeof rawPrice === "object") {
    return {
      value: Number(rawPrice.value || rawPrice.amount || rawPrice.price || 0),
      currency: String(rawPrice.currency || rawPrice.currencyCode || listing?.currency || "USD").toUpperCase()
    };
  }
  return {
    value: Number(rawPrice || 0),
    currency: String(listing?.currency || listing?.currencyCode || "USD").toUpperCase()
  };
}

function normalizeCondition(value) {
  if (!value) return null;
  const normalized = String(value).trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (["NM", "NEAR_MINT", "NEARMINT"].includes(normalized)) return "NEAR_MINT";
  return normalized;
}

function getPreMedianRejection(listing) {
  if (!Number.isFinite(listing.price) || listing.price <= 0 || listing.soldAt <= 0) return "invalid";
  if (listing.currency !== "USD") return "nonUsd";
  if (listing.anomalyFlag) return "anomalyFlag";
  if (listing.grader || listing.grade || isGradedTitle(listing.title)) return "graded";
  if (listing.condition && listing.condition !== "NEAR_MINT") return "nonNearMint";
  return null;
}

function isGradedTitle(title) {
  return /\b(PSA|BGS|CGC|SGC|TAG|ACE)\s*(?:[0-9](?:\.[0-9])?|10)\b|\bGRADED\b/i.test(title || "");
}

function filterMedianOutliers(listings) {
  if (listings.length < 4) return listings;
  const center = median(listings.map((listing) => listing.price));
  const deviations = listings.map((listing) => Math.abs(listing.price - center));
  const mad = median(deviations);
  const tolerance = Math.max(center * 0.1, mad * 3);
  return listings.filter((listing) => Math.abs(listing.price - center) <= tolerance);
}

function hashCleanComps(listings) {
  const payload = listings
    .map((listing) => ({
      id: listing.id,
      price: roundUsd(listing.price),
      soldAt: listing.soldAt,
      condition: listing.condition || "UNKNOWN"
    }))
    .sort((left, right) => left.soldAt - right.soldAt || left.price - right.price || left.id.localeCompare(right.id));
  return `0x${crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function parseTimestamp(value) {
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0;
}

function roundUsd(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeOptionalNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function resolvePath(configured) {
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

module.exports = {
  computePoketraceAggregatePrice,
  computePoketracePrice,
  createPoketraceClient,
  filterMedianOutliers,
  median,
  normalizeCondition,
  normalizeListing
};
