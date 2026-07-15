const fs = require("fs");
const path = require("path");
const { EWMA_TIERS, PRICE_SCALE, smoothQuote } = require("./oracle-smoothing.cjs");
const { cardOracleTargets, registryPriceFloors } = require("./oracle-market-registry.cjs");
const { createPoketraceClient } = require("./poketrace-oracle.cjs");
const { fetchPokeliquidPl500Quote, pl500Source } = require("./pl500-market.cjs");
require("dotenv").config({ path: ".env.local", quiet: true });
if (process.env.NODE_ENV === "production") require("dotenv").config({ path: ".env.production", quiet: true });
require("dotenv").config({ quiet: true });

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_SCRAPE_CONCURRENCY = 22;
const DEFAULT_TCGPLAYER_SOURCE = "playwright";
const DEFAULT_PRIMARY_SOURCE = "tcgplayer";
const DEFAULT_CACHE_PATH = "data/oracle/prices.json";
const DEFAULT_SKU_CACHE_PATH = "data/oracle/tcgplayer-skus.json";
const DEFAULT_PL500_PATH = "data/oracle/pl500-constituents.json";
const DEFAULT_PRICE_FLOOR_PATH = "data/oracle/price-floors.json";
const DEFAULT_POKETRACE_CACHE_PATH = "data/oracle/poketrace-prices.json";
const DEFAULT_POKETRACE_POLL_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_PRIMARY_MAX_AGE_SECONDS = 30 * 60;
const DEFAULT_TCGPLAYER_CONDITION_ID = 1;
const DEFAULT_TCGPLAYER_LANGUAGE_ID = 1;
const DEFAULT_TCGPLAYER_CONDITION_LABEL = "Near Mint";

async function main() {
  const result = await scrapeCycle();
  if (result.successfulMarkets === 0 && result.targetCount > 0) process.exitCode = 1;
}

async function scrapeCycle(options = {}) {
  validateSourceConfiguration();
  const persist = options.persist !== false;
  const quiet = options.quiet === true;
  const now = Math.floor(Date.now() / 1000);
  const intervalMs = Number(process.env.ORACLE_SCRAPE_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  const cachePath = resolveCachePath();
  const previous = options.previousPayload || readCache(cachePath);
  const targets = selectTargets();
  const prices = { ...(previous?.prices || {}) };
  const failures = [];
  const primaryFailures = [];
  const observedSources = new Set();
  const priceFloors = loadPriceFloors();
  let successfulMarkets = 0;
  let tcgplayerSuccesses = 0;
  let poketraceSuccesses = 0;
  const apiClient = await createTcgplayerApiClient();
  const poketraceClient = createPoketraceClient();
  const poketraceCachePath = resolvePoketraceCachePath();
  const previousPoketrace = options.previousPoketrace || readCache(poketraceCachePath) || { version: 1, prices: {} };
  const poketracePrices = { ...(previousPoketrace.prices || {}) };
  const poketracePollIntervalMs = Number(process.env.ORACLE_POKETRACE_POLL_INTERVAL_MS || DEFAULT_POKETRACE_POLL_INTERVAL_MS);
  const shouldPollPoketrace = Boolean(poketraceClient) && now * 1000 - Number(previousPoketrace.lastAttemptAt || 0) * 1000 >= poketracePollIntervalMs;
  const browserState = { browser: null, context: null, contextPromise: null };
  const scrapeConcurrency = normalizeConcurrency(
    process.env.ORACLE_SCRAPE_CONCURRENCY || DEFAULT_SCRAPE_CONCURRENCY,
    targets.length
  );

  try {
    await mapWithConcurrency(targets, scrapeConcurrency, async (market) => {
      if (shouldPollPoketrace && market.poketraceEligible) {
        try {
          poketracePrices[market.priceKey] = await poketraceClient.fetchMarketPrice(market, now);
          poketraceSuccesses += 1;
        } catch (error) {
          primaryFailures.push({
            market: market.priceKey,
            tcgplayerId: market.tcgplayerId,
            source: "poketrace-ewap",
            message: error instanceof Error ? error.message : String(error)
          });
        }
      }

      try {
        const { selectedQuote, secondaryQuote } = await selectOracleQuote({
          market,
          apiClient,
          browserState,
          poketracePrices,
          now
        });
        if (isTcgplayerSource(selectedQuote.source) || isTcgplayerSource(secondaryQuote?.source)) {
          tcgplayerSuccesses += 1;
        }

        const rawPrice = Math.round(selectedQuote.priceUsd * PRICE_SCALE);
        const previousQuote = previous?.prices?.[market.priceKey];
        const priceFloor = getPriceFloor(market.priceKey, priceFloors);
        const observedAt = Number(selectedQuote.observedAt || now);
        const crossSource = crossSourceStatus(selectedQuote, secondaryQuote);
        const metadata = {
          ...(selectedQuote.metadata || {}),
          sourceObservedAt: observedAt,
          secondaryPrice: secondaryQuote?.priceUsd,
          secondarySource: secondaryQuote?.source,
          secondaryObservedAt: secondaryQuote?.observedAt || now,
          tcgplayerFallbackPrice: isTcgplayerSource(secondaryQuote?.source) ? secondaryQuote.priceUsd : undefined,
          tcgplayerFallbackSource: isTcgplayerSource(secondaryQuote?.source) ? secondaryQuote.source : undefined,
          tcgplayerFallbackObservedAt: isTcgplayerSource(secondaryQuote?.source) ? secondaryQuote.observedAt || now : undefined,
          independentSourceCount: crossSource.acceptedSources,
          crossSource
        };
        const isRepeatedPrimaryObservation =
          isPoketraceSource(selectedQuote.source) &&
          previousQuote?.source === selectedQuote.source &&
          Number(previousQuote.sourceObservedAt || 0) === observedAt;

        const nextQuote = isRepeatedPrimaryObservation
          ? { ...previousQuote, ...metadata }
          : smoothQuote(rawPrice, previousQuote, observedAt, selectedQuote.source, {
              snapshotOnly: market.snapshotOnly,
              metadata,
              priceFloor
            });
        prices[market.priceKey] = withRefreshChange(nextQuote, previousQuote, now);
        observedSources.add(selectedQuote.source);
        successfulMarkets += 1;
        if (!quiet) {
          console.log(
            `${market.priceKey}: raw $${selectedQuote.priceUsd.toFixed(2)} -> ewma $${(prices[market.priceKey].price / PRICE_SCALE).toFixed(2)} (${selectedQuote.source}${isRepeatedPrimaryObservation ? ", cached observation" : ""})`
          );
        }
      } catch (error) {
        const previousQuote = previous?.prices?.[market.priceKey];
        if (previousQuote) prices[market.priceKey] = withRefreshChange(previousQuote, previousQuote, now);
        failures.push({
          market: market.priceKey,
          tcgplayerId: market.tcgplayerId,
          message: error instanceof Error ? error.message : String(error)
        });
        if (!quiet) console.warn(`${market.priceKey}: ${failures.at(-1).message}`);
      }
    });
  } finally {
    if (apiClient?.close) apiClient.close();
    if (poketraceClient?.close) poketraceClient.close();
    if (browserState.browser) await browserState.browser.close();
  }

  const previousPl500Quote = previous?.prices?.PL500;
  let pl500Quote;
  if (pl500Source() === "pokeliquid-api") {
    try {
      const upstream = await fetchPokeliquidPl500Quote({ now });
      const repeated = previousPl500Quote?.source === upstream.source
        && Number(previousPl500Quote.sourceObservedAt || 0) === upstream.observedAt;
      const metadata = {
        sourceObservedAt: upstream.observedAt,
        independentSourceCount: 1,
        upstreamEwmaUsd: upstream.upstreamEwmaUsd,
        upstreamTransactionSignature: upstream.transactionSignature,
        upstreamId: upstream.upstreamId,
        upstreamDeviation: upstream.upstreamDeviation,
        upstreamAlpha: upstream.upstreamAlpha,
        upstreamUrl: upstream.sourceUrl,
        method: "pokeliquid-public-pl500-then-hoodliquid-adaptive-ewma",
        indicative: false,
        tradable: true
      };
      pl500Quote = repeated
        ? { ...previousPl500Quote, ...metadata }
        : smoothQuote(Math.round(upstream.rawPriceUsd * PRICE_SCALE), previousPl500Quote, upstream.observedAt, upstream.source, {
            priceFloor: getPriceFloor("PL500", priceFloors),
            metadata
          });
      observedSources.add(upstream.source);
      successfulMarkets += 1;
      if (!quiet) {
        console.log(`PL500: raw $${upstream.rawPriceUsd.toFixed(2)} -> ewma $${(pl500Quote.price / PRICE_SCALE).toFixed(2)} (${upstream.source}${repeated ? ", cached observation" : ""})`);
      }
    } catch (error) {
      failures.push({
        market: "PL500",
        source: "pokeliquid-api",
        message: error instanceof Error ? error.message : String(error)
      });
      pl500Quote = previousPl500Quote?.source === "pokeliquid-api"
        ? previousPl500Quote
        : buildPl500IndexQuote({ prices, previousQuote: previousPl500Quote, priceFloors, now });
      if (!quiet) console.warn(`PL500: ${failures.at(-1).message}`);
    }
  } else {
    pl500Quote = buildPl500IndexQuote({ prices, previousQuote: previousPl500Quote, priceFloors, now });
  }
  prices.PL500 = withRefreshChange(pl500Quote, previousPl500Quote, now);

  let poketracePayload = previousPoketrace;
  if (shouldPollPoketrace) {
    poketracePayload = {
      version: 1,
      updatedAt: latestPrimaryTimestamp(poketracePrices),
      lastAttemptAt: now,
      lastSuccessAt: poketraceSuccesses > 0 ? now : Number(previousPoketrace.lastSuccessAt || 0),
      pollIntervalMs: poketracePollIntervalMs,
      prices: poketracePrices,
      failures: primaryFailures
    };
    if (persist) writeJsonAtomic(poketraceCachePath, poketracePayload);
  }

  const updatedAt = latestQuoteTimestamp(prices);
  const payload = {
    version: 1,
    updatedAt,
    lastAttemptAt: now,
    scrapeIntervalMs: intervalMs,
    source: observedSources.size > 0 ? chooseCacheSource(observedSources, Boolean(apiClient)) : previous?.source || chooseCacheSource(observedSources, Boolean(apiClient)),
    smoothing: {
      method: "adaptive-ewma",
      tiers: EWMA_TIERS.map((tier) => ({
        maxDeviationBps: Number.isFinite(tier.maxDeviationBps) ? tier.maxDeviationBps : null,
        alpha: tier.alpha,
        mode: tier.tier
      })),
      priceFloorConfig: resolvePriceFloorPath()
    },
    acquisition: {
      primary: oraclePrimarySource(),
      tcgplayerMode: tcgplayerSourceMode(),
      pl500Source: pl500Source(),
      concurrency: scrapeConcurrency,
      playwrightEnabled: allowPlaywrightScraping()
    },
    prices,
    failures,
    poketrace: {
      source: "poketrace",
      configured: Boolean(poketraceClient),
      pollIntervalMs: poketracePollIntervalMs,
      polledThisCycle: shouldPollPoketrace,
      successfulMarkets: poketraceSuccesses,
      activeMarkets: Object.values(prices).filter((quote) => isPoketraceSource(quote?.source)).length,
      failures: primaryFailures
    },
    tcgplayer: {
      source: "tcgplayer-near-mint",
      mode: tcgplayerSourceMode(),
      successfulMarkets: tcgplayerSuccesses
    },
    successfulMarkets,
    targetCount: targets.length
  };

  if (persist) {
    writeJsonAtomic(cachePath, payload);
    appendHistory(payload, now);
    console.log(`Wrote ${Object.keys(prices).length} oracle prices to ${cachePath}`);
  }
  return { successfulMarkets, targetCount: targets.length, failures, updatedAt, payload, poketracePayload };
}

async function selectOracleQuote({ market, apiClient, browserState, poketracePrices, now }) {
  const poketraceQuote = getFreshPoketraceQuote(market, poketracePrices[market.priceKey], now);
  let tcgplayerError = null;
  let tcgplayerQuote = null;
  try {
    tcgplayerQuote = await fetchTcgplayerMarketPrice(market, apiClient, browserState);
  } catch (error) {
    tcgplayerError = error;
  }

  if (oraclePrimarySource() === "poketrace") {
    if (poketraceQuote) return { selectedQuote: poketraceQuote, secondaryQuote: tcgplayerQuote };
    if (tcgplayerQuote) return { selectedQuote: tcgplayerQuote, secondaryQuote: null };
  } else {
    if (tcgplayerQuote) return { selectedQuote: tcgplayerQuote, secondaryQuote: poketraceQuote };
    if (poketraceQuote) return { selectedQuote: poketraceQuote, secondaryQuote: null };
  }

  if (market.snapshotOnly) {
    return { selectedQuote: getApprovedSnapshotQuote(market), secondaryQuote: null };
  }

  throw tcgplayerError || new Error("No valid TCGPlayer or PokeTrace oracle quote");
}

function crossSourceStatus(selectedQuote, secondaryQuote) {
  if (!secondaryQuote || secondaryQuote.source === selectedQuote.source) {
    return { status: "single-source", acceptedSources: 1, deviationBps: null };
  }
  const selected = Number(selectedQuote.priceUsd || 0);
  const secondary = Number(secondaryQuote.priceUsd || 0);
  if (selected <= 0 || secondary <= 0) return { status: "invalid-secondary", acceptedSources: 1, deviationBps: null };
  const deviationBps = Math.round(Math.abs(secondary - selected) * 10_000 / selected);
  const maximum = Number(process.env.ORACLE_MAX_SOURCE_DEVIATION_BPS || 3_000);
  return {
    status: deviationBps <= maximum ? "confirmed" : "secondary-outlier",
    acceptedSources: deviationBps <= maximum ? 2 : 1,
    deviationBps,
    maxDeviationBps: maximum
  };
}

async function fetchTcgplayerMarketPrice(market, apiClient, browserState) {
  if (!market.tcgplayerId) throw new Error("Missing TCGPlayer product id");
  const mode = tcgplayerSourceMode();
  if (mode === "api") {
    if (!apiClient) throw new Error("Missing TCGPlayer API credentials; set TCGPLAYER_BEARER_TOKEN or public/private keys");
    return fetchTcgplayerApiQuote(market, apiClient);
  }
  if (mode === "auto" && apiClient) {
    try {
      return await fetchTcgplayerApiQuote(market, apiClient);
    } catch (error) {
      if (!allowPlaywrightScraping()) throw error;
    }
  }
  if (!allowPlaywrightScraping()) {
    if (apiClient) return fetchTcgplayerApiQuote(market, apiClient);
    throw new Error("TCGPlayer Playwright scraping is disabled; set ORACLE_PLAYWRIGHT_ENABLED=true or configure API credentials");
  }

  const context = await ensureBrowserContext(browserState);
  return {
    priceUsd: await scrapeMarketPrice(context, market),
    source: "tcgplayer-playwright",
    observedAt: Math.floor(Date.now() / 1000),
    metadata: {
      conditionName: getPreferredConditionLabel(market),
      conditionId: getPreferredConditionId(market),
      languageId: getPreferredLanguageId(market),
      productUrl: market.tcgplayerUrl
    }
  };
}

async function fetchTcgplayerApiQuote(market, apiClient) {
  const quote = await apiClient.fetchMarketPrice(market);
  return {
    priceUsd: quote.priceUsd,
    source: "tcgplayer-api",
    observedAt: Math.floor(Date.now() / 1000),
    metadata: {
      productConditionId: quote.productConditionId,
      conditionId: quote.conditionId,
      languageId: quote.languageId
    }
  };
}

async function ensureBrowserContext(browserState) {
  assertPlaywrightPermission();
  if (browserState.context) return browserState.context;
  if (!browserState.contextPromise) {
    browserState.contextPromise = (async () => {
      const { chromium } = await import("playwright");
      browserState.browser = await chromium.launch({
        headless: process.env.ORACLE_HEADLESS !== "false"
      });
      browserState.context = await browserState.browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
        locale: "en-US",
        viewport: { width: 1365, height: 900 }
      });
      return browserState.context;
    })();
  }
  return browserState.contextPromise;
}

function getApprovedSnapshotQuote(market) {
  const priceUsd = Number(market.seedPriceUsd || 0);
  if (!market.snapshotOnly || !Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error(`No approved snapshot price for ${market.priceKey}`);
  }
  return {
    priceUsd,
    source: "snapshot",
    metadata: {
      conditionName: market.conditionName,
      conditionId: market.conditionId,
      languageId: market.languageId,
      snapshotOnly: true
    }
  };
}

function allowPlaywrightFallback() {
  return allowPlaywrightScraping();
}

function allowPlaywrightScraping() {
  if (process.env.ORACLE_PLAYWRIGHT_ENABLED !== undefined) {
    return process.env.ORACLE_PLAYWRIGHT_ENABLED === "true";
  }
  if (tcgplayerSourceMode() === "playwright") return true;
  return process.env.ORACLE_PLAYWRIGHT_FALLBACK === "true";
}

function requiresPlaywrightPermission() {
  return tcgplayerSourceMode() === "playwright" || allowPlaywrightScraping();
}

function assertPlaywrightPermission() {
  if (
    requiresPlaywrightPermission()
    && process.env.ORACLE_TCGPLAYER_SCRAPING_PERMISSION_CONFIRMED !== "true"
  ) {
    throw new Error(
      "TCGPlayer Playwright collection requires express permission from TCGPlayer. "
      + "After obtaining permission, set ORACLE_TCGPLAYER_SCRAPING_PERMISSION_CONFIRMED=true. "
      + "This confirmation is an operator acknowledgement and does not grant permission."
    );
  }
  return true;
}

function validateSourceConfiguration() {
  tcgplayerSourceMode();
  oraclePrimarySource();
  pl500Source();
  if (requiresPlaywrightPermission()) assertPlaywrightPermission();
  return true;
}

function tcgplayerSourceMode() {
  const mode = String(process.env.ORACLE_TCGPLAYER_SOURCE || DEFAULT_TCGPLAYER_SOURCE).trim().toLowerCase();
  if (!["playwright", "api", "auto"].includes(mode)) {
    throw new Error("ORACLE_TCGPLAYER_SOURCE must be playwright, api, or auto");
  }
  return mode;
}

function oraclePrimarySource() {
  const source = String(process.env.ORACLE_PRIMARY_SOURCE || DEFAULT_PRIMARY_SOURCE).trim().toLowerCase();
  if (!["tcgplayer", "poketrace"].includes(source)) {
    throw new Error("ORACLE_PRIMARY_SOURCE must be tcgplayer or poketrace");
  }
  return source;
}

async function createTcgplayerApiClient() {
  const token = process.env.TCGPLAYER_BEARER_TOKEN || await fetchTcgplayerBearerToken();
  if (!token) return null;

  const baseUrl = process.env.TCGPLAYER_API_BASE_URL || "https://api.tcgplayer.com";
  const skuCachePath = resolveSkuCachePath();
  const skuCache = readSkuCache(skuCachePath);
  return {
    async fetchMarketPrice(market) {
      return fetchSkuMarketPrice({
        market,
        token,
        baseUrl,
        skuCache
      });
    },
    close() {
      writeSkuCache(skuCachePath, skuCache);
    }
  };
}

async function fetchSkuMarketPrice({ market, token, baseUrl, skuCache }) {
  const productId = market.tcgplayerId;
  const cacheKey = String(productId);
  const cachedSku = skuCache.products[cacheKey];

  if (cachedSku?.productConditionId && skuMatchesPreferences(cachedSku, market)) {
    try {
      return await fetchMarketPriceByProductConditionId({
        productConditionId: cachedSku.productConditionId,
        token,
        baseUrl,
        sku: cachedSku
      });
    } catch {
      delete skuCache.products[cacheKey];
    }
  } else if (cachedSku) {
    delete skuCache.products[cacheKey];
  }

  const skus = await fetchProductSkus({ productId, token, baseUrl });
  const selected = await selectPricedSku({ skus, token, baseUrl, market });
  skuCache.products[cacheKey] = {
    productId,
    productConditionId: selected.productConditionId,
    conditionId: selected.conditionId,
    languageId: selected.languageId,
    updatedAt: Math.floor(Date.now() / 1000)
  };
  return selected;
}

async function fetchProductSkus({ productId, token, baseUrl }) {
  const payload = await fetchTcgplayerJson(`${baseUrl}/catalog/products/${productId}/skus`, token, "SKU resolver");
  const skus = resultArray(payload)
    .map(normalizeSku)
    .filter((sku) => sku.productConditionId > 0);
  if (skus.length === 0) throw new Error(`TCGPlayer SKU resolver returned no SKUs for product ${productId}`);
  return skus;
}

async function selectPricedSku({ skus, token, baseUrl, market }) {
  const preferredConditionId = getPreferredConditionId(market);
  const preferredLanguageId = getPreferredLanguageId(market);
  const exact = skus.filter((sku) => matchesSkuPreference(sku.conditionId, preferredConditionId) && matchesSkuPreference(sku.languageId, preferredLanguageId));
  if (exact.length === 0 && !allowNonPreferredSkuFallback()) {
    throw new Error(
      `TCGPlayer SKU resolver found no ${getPreferredConditionLabel(market)} English SKU for product ${market.tcgplayerId}`
    );
  }
  const candidates = exact.length > 0 ? exact : skus;
  const selectionMode = (process.env.ORACLE_TCGPLAYER_SKU_SELECTION || "highest").toLowerCase();
  let priced = await priceSkuCandidates({ candidates, token, baseUrl });

  if (priced.length === 0 && candidates.length !== skus.length && allowNonPreferredSkuFallback()) {
    priced = await priceSkuCandidates({ candidates: skus, token, baseUrl });
  }

  if (priced.length === 0) {
    throw new Error(`TCGPlayer SKU market price API returned no priced ${getPreferredConditionLabel(market)} English candidates`);
  }
  if (selectionMode === "first") return priced[0];
  return priced.sort((left, right) => right.priceUsd - left.priceUsd)[0];
}

async function priceSkuCandidates({ candidates, token, baseUrl }) {
  const priced = [];
  for (const sku of candidates) {
    try {
      priced.push(await fetchMarketPriceByProductConditionId({ productConditionId: sku.productConditionId, token, baseUrl, sku }));
    } catch {}
  }
  return priced;
}

async function fetchMarketPriceByProductConditionId({ productConditionId, token, baseUrl, sku }) {
  const payload = await fetchTcgplayerJson(`${baseUrl}/pricing/marketprices/${productConditionId}`, token, "SKU market price");
  const result = resultArray(payload);
  const entry = result[0] || payload;
  const priceUsd = Number(entry.price || entry.marketPrice || entry.market_price || 0);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) throw new Error(`TCGPlayer SKU ${productConditionId} returned no market price`);

  return {
    priceUsd,
    productConditionId: Number(entry.productConditionId || productConditionId),
    conditionId: sku?.conditionId,
    languageId: sku?.languageId
  };
}

async function fetchTcgplayerJson(url, token, label) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json"
    }
  });
  if (!response.ok) throw new Error(`TCGPlayer ${label} API ${response.status}`);
  return response.json();
}

function resultArray(payload) {
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.result)) return payload.result;
  if (payload?.result && typeof payload.result === "object") return [payload.result];
  return [];
}

function normalizeSku(entry) {
  return {
    productConditionId: Number(entry.productConditionId || entry.skuId || entry.id || 0),
    conditionId: nullableNumber(entry.conditionId),
    languageId: nullableNumber(entry.languageId)
  };
}

function nullableNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function matchesSkuPreference(value, preferred) {
  if (!preferred) return true;
  return value === preferred;
}

function skuMatchesPreferences(sku, market) {
  return matchesSkuPreference(sku.conditionId, getPreferredConditionId(market)) && matchesSkuPreference(sku.languageId, getPreferredLanguageId(market));
}

function allowNonPreferredSkuFallback() {
  return process.env.ORACLE_TCGPLAYER_ALLOW_NONPREFERRED_SKU === "true" && process.env.ORACLE_REQUIRE_AUTHENTICATED_SOURCES !== "true";
}

function getPreferredConditionId(market = {}) {
  return Number(market.conditionId || process.env.ORACLE_TCGPLAYER_CONDITION_ID || DEFAULT_TCGPLAYER_CONDITION_ID);
}

function getPreferredLanguageId(market = {}) {
  return Number(market.languageId || process.env.ORACLE_TCGPLAYER_LANGUAGE_ID || DEFAULT_TCGPLAYER_LANGUAGE_ID);
}

function getPreferredConditionLabel(market = {}) {
  return market.conditionName || process.env.ORACLE_TCGPLAYER_CONDITION_LABEL || DEFAULT_TCGPLAYER_CONDITION_LABEL;
}

async function fetchTcgplayerBearerToken() {
  if (!process.env.TCGPLAYER_PUBLIC_KEY || !process.env.TCGPLAYER_PRIVATE_KEY) return null;
  const baseUrl = process.env.TCGPLAYER_API_BASE_URL || "https://api.tcgplayer.com";
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.TCGPLAYER_PUBLIC_KEY,
    client_secret: process.env.TCGPLAYER_PRIVATE_KEY
  });
  const response = await fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  if (!response.ok) throw new Error(`TCGPlayer token API ${response.status}`);
  const payload = await response.json();
  return payload.access_token;
}

async function scrapeMarketPrice(context, market) {
  const page = await context.newPage();
  const url = market.tcgplayerUrl || `https://www.tcgplayer.com/product/${market.tcgplayerId}?page=1&Language=English`;

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(1_500);

    const bodyText = await page.locator("body").innerText({ timeout: 15_000 });
    const price = extractMarketPrice(bodyText, getPreferredConditionLabel(market));
    if (!price) {
      throw new Error("TCGPlayer market price not found in page text");
    }
    return price;
  } finally {
    await page.close();
  }
}

function extractMarketPrice(text, conditionName = getPreferredConditionLabel()) {
  const compact = text.replace(/\s+/g, " ");
  const conditionLabel = escapeRegExp(conditionName);
  const patterns = [
    new RegExp(`Price Points\\s*${conditionLabel}(?:\\s+(?:Holofoil|Normal|Reverse Holofoil|1st Edition Holofoil|Unlimited Holofoil))?\\s*Market Price\\s*\\$?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)`, "i"),
    new RegExp(`${conditionLabel} Comparison Prices.*?(?:Holofoil|Normal|Reverse Holofoil|1st Edition Holofoil|Unlimited Holofoil):\\s*\\$?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)`, "i"),
    /Near Mint Comparison Prices.*?(?:Holofoil|Normal|Reverse Holofoil|1st Edition Holofoil|Unlimited Holofoil):\s*\$?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/i
  ];

  for (const pattern of patterns) {
    const match = compact.match(pattern);
    if (!match) continue;
    const value = Number(match[1].replace(/,/g, ""));
    if (Number.isFinite(value) && value > 0) return value;
  }

  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function selectTargets() {
  const requested = (process.env.ORACLE_MARKETS || "ALL")
    .split(",")
    .map((market) => market.trim().toUpperCase())
    .filter(Boolean);
  const includeAll = requested.length === 0 || requested.includes("ALL");
  const limit = Number(process.env.ORACLE_SCRAPE_LIMIT || 0);
  const pl500List = loadPl500List();
  const pl500Targets = pl500List.constituents
    .filter((constituent) => constituent.tcgplayerId || constituent.snapshotOnly)
    .map((constituent) => ({
      priceKey: constituent.id,
      tcgplayerId: constituent.tcgplayerId,
      card: constituent.card,
      set: constituent.set,
      seedPriceUsd: constituent.seedPriceUsd,
      snapshotOnly: Boolean(constituent.snapshotOnly),
      conditionName: constituent.conditionName || getPreferredConditionLabel(),
      conditionId: Number(constituent.conditionId || getPreferredConditionId()),
      languageId: Number(constituent.languageId || getPreferredLanguageId()),
      tcgplayerUrl: constituent.tcgplayerUrl || (constituent.tcgplayerId ? `https://www.tcgplayer.com/product/${constituent.tcgplayerId}?page=1&Language=English` : undefined)
    }));
  const selected = pl500Targets.filter(
    (market) => includeAll || requested.includes(market.priceKey.toUpperCase()) || requested.includes(String(market.tcgplayerId))
  );
  const registryTargets = cardOracleTargets();
  const selectedRegistryMarkets = registryTargets.filter(
    (market) =>
      includeAll ||
      requested.includes("CHARIZARD-INDEX") ||
      requested.includes(market.priceKey.toUpperCase()) ||
      requested.includes(String(market.tcgplayerId))
  );

  const targets = [...selected, ...selectedRegistryMarkets];
  return limit > 0 ? targets.slice(0, limit) : targets;
}

function loadPl500List() {
  const configured = process.env.ORACLE_PL500_CONSTITUENTS || DEFAULT_PL500_PATH;
  const filePath = path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function chooseCacheSource(observedSources, hasApiClient) {
  if (observedSources.has("pokeliquid-api")) return "pokeliquid-api";
  if (observedSources.has("poketrace-ewap")) return "poketrace-ewap";
  if (observedSources.has("poketrace-aggregate")) return "poketrace-aggregate";
  if (observedSources.has("tcgplayer-api")) return "tcgplayer-api";
  if (observedSources.has("tcgplayer-playwright")) return "tcgplayer-playwright";
  if (observedSources.has("snapshot")) return "snapshot";
  return hasApiClient ? "tcgplayer-api" : "snapshot";
}

function readCache(cachePath) {
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf8"));
  } catch {
    return null;
  }
}

function readSkuCache(cachePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    if (parsed && parsed.products && typeof parsed.products === "object") return parsed;
  } catch {}
  return { version: 1, products: {} };
}

function writeSkuCache(cachePath, skuCache) {
  writeJsonAtomic(cachePath, skuCache);
}

function resolveCachePath() {
  const configured = process.env.ORACLE_PRICE_CACHE || DEFAULT_CACHE_PATH;
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function resolveSkuCachePath() {
  const configured = process.env.ORACLE_TCGPLAYER_SKU_CACHE || DEFAULT_SKU_CACHE_PATH;
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function resolvePoketraceCachePath() {
  const configured = process.env.ORACLE_POKETRACE_PRICE_CACHE || DEFAULT_POKETRACE_CACHE_PATH;
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function resolvePriceFloorPath() {
  const configured = process.env.ORACLE_PRICE_FLOORS || DEFAULT_PRICE_FLOOR_PATH;
  return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
}

function loadPriceFloors() {
  const registryFloors = registryPriceFloors();
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvePriceFloorPath(), "utf8"));
    return {
      defaultFloorUsd: Number(parsed.defaultFloorUsd || 0),
      markets: {
        ...(parsed.markets && typeof parsed.markets === "object" ? parsed.markets : {}),
        ...registryFloors
      }
    };
  } catch {
    return { defaultFloorUsd: 0, markets: registryFloors };
  }
}

function getPriceFloor(priceKey, priceFloors) {
  const floorUsd = Number(priceFloors.markets[priceKey] ?? priceFloors.defaultFloorUsd ?? 0);
  return Number.isFinite(floorUsd) && floorUsd > 0 ? Math.round(floorUsd * PRICE_SCALE) : 0;
}

function latestQuoteTimestamp(prices) {
  return Object.values(prices).reduce((latest, quote) => Math.max(latest, Number(quote?.lastUpdateTime || 0)), 0);
}

function withRefreshChange(quote, previousQuote, refreshedAt) {
  if (!quote) return quote;
  const previousPrice = Number(previousQuote?.price || 0);
  const currentPrice = Number(quote.price || 0);
  const change = previousPrice > 0 && currentPrice > 0 ? currentPrice - previousPrice : 0;
  const changeBps = previousPrice > 0 ? Math.round((change * 10_000) / previousPrice) : 0;
  const previousRawPrice = Number(previousQuote?.rawPrice || 0);
  const currentRawPrice = Number(quote.rawPrice || 0);
  const rawChange = previousRawPrice > 0 && currentRawPrice > 0 ? currentRawPrice - previousRawPrice : 0;
  const rawChangeBps = previousRawPrice > 0 ? Math.round((rawChange * 10_000) / previousRawPrice) : 0;

  return {
    ...quote,
    refreshPreviousPrice: previousPrice,
    refreshChange: change,
    refreshChangeBps: changeBps,
    refreshChangeUsd: change / PRICE_SCALE,
    rawRefreshPreviousPrice: previousRawPrice,
    rawRefreshChange: rawChange,
    rawRefreshChangeBps: rawChangeBps,
    rawRefreshChangeUsd: rawChange / PRICE_SCALE,
    refreshChangedAt: refreshedAt
  };
}

function buildPl500IndexQuote({ prices, previousQuote, priceFloors, now }) {
  const pl500 = loadPl500List();
  const rows = pl500.constituents.map((constituent) => {
    const quote = prices[constituent.id];
    const rawPrice = Number(quote?.rawPrice || quote?.price || Math.round(constituent.seedPriceUsd * PRICE_SCALE));
    const live = Boolean(
      quote && (isPoketraceSource(quote.source) || quote.source === "tcgplayer-api" || quote.source === "tcgplayer-playwright" || quote.source === "snapshot")
    );
    return { quote, rawPrice, live };
  });
  const rawPrice = rows.reduce((sum, row) => sum + row.rawPrice, 0);
  const liveConstituentCount = rows.filter((row) => row.live).length;
  const complete = liveConstituentCount === pl500.constituents.length;

  if (!complete) {
    return {
      price: rawPrice,
      rawPrice,
      ewma: rawPrice / PRICE_SCALE,
      lastUpdateTime: now,
      sourceObservedAt: now,
      source: "user-top500-list",
      indicative: true,
      tradable: false,
      method: "seed-and-resolved-constituent-sum",
      constituentCount: pl500.constituents.length,
      liveConstituentCount,
      seedTotalUsd: pl500.seedTotalUsd
    };
  }

  const observedTimestamps = rows.map((row) => Number(row.quote.lastUpdateTime || 0)).filter((timestamp) => timestamp > 0);
  const observedAt = observedTimestamps.length === rows.length ? Math.min(...observedTimestamps) : 0;
  if (observedAt <= 0) {
    return {
      price: rawPrice,
      rawPrice,
      ewma: rawPrice / PRICE_SCALE,
      lastUpdateTime: now,
      sourceObservedAt: now,
      source: "user-top500-list",
      indicative: true,
      tradable: false,
      method: "seed-and-resolved-constituent-sum",
      constituentCount: pl500.constituents.length,
      liveConstituentCount,
      seedTotalUsd: pl500.seedTotalUsd
    };
  }
  const isRepeatedObservation =
    previousQuote?.source === "tcgplayer-index" && Number(previousQuote.sourceObservedAt || 0) === observedAt;
  if (isRepeatedObservation) return previousQuote;

  return {
    ...smoothQuote(rawPrice, previousQuote, observedAt, "tcgplayer-index", {
      priceFloor: getPriceFloor("PL500", priceFloors),
      metadata: {
        sourceObservedAt: observedAt,
        constituentCount: pl500.constituents.length,
        liveConstituentCount,
        method: "raw-constituent-sum-then-ewma"
      }
    }),
    constituentCount: pl500.constituents.length,
    liveConstituentCount
  };
}

function latestPrimaryTimestamp(prices) {
  return Object.values(prices).reduce((latest, quote) => Math.max(latest, Number(quote?.observedAt || 0)), 0);
}

function getFreshPoketraceQuote(market, quote, now) {
  if (!market.poketraceEligible || !quote?.priceUsd || !isPoketraceSource(quote.source)) return null;
  const observedAt = Number(quote.observedAt || 0);
  const maxAge = Number(process.env.ORACLE_POKETRACE_MAX_AGE_SECONDS || DEFAULT_PRIMARY_MAX_AGE_SECONDS);
  if (observedAt <= 0 || now < observedAt || now - observedAt > maxAge) return null;
  return quote;
}

function isPoketraceSource(source) {
  return source === "poketrace-ewap" || source === "poketrace-aggregate";
}

function isTcgplayerSource(source) {
  return source === "tcgplayer-playwright" || source === "tcgplayer-api" || source === "tcgplayer-index";
}

function appendHistory(payload, cycleTimestamp) {
  const configured = process.env.ORACLE_HISTORY_CACHE || "data/oracle/history.json";
  const historyPath = path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  const history = readCache(historyPath) || { version: 1, markets: {} };
  const cutoff = cycleTimestamp - Number(process.env.ORACLE_HISTORY_RETENTION_SECONDS || 7 * 24 * 60 * 60);

  for (const [market, quote] of Object.entries(payload.prices)) {
    const quoteTimestamp = Number(quote.lastUpdateTime || 0);
    if (quoteTimestamp <= 0) continue;
    const points = history.markets[market] || [];
    if (Number(points.at(-1)?.timestamp || 0) !== quoteTimestamp) {
      points.push({ timestamp: quoteTimestamp, price: quote.price });
    }
    history.markets[market] = points.filter((point) => point.timestamp >= cutoff).slice(-2_016);
  }

  writeJsonAtomic(historyPath, history);
}

function isKeeperActionDue({ lastActionAt, nowMs, intervalMs }) {
  const last = Number(lastActionAt || 0);
  if (last <= 0) return true;
  return Math.floor(nowMs / 1000) >= last + Math.ceil(intervalMs / 1000);
}

function normalizeInterval(value) {
  const intervalMs = Number(value);
  if (!Number.isFinite(intervalMs) || intervalMs < 60_000) {
    throw new Error("Oracle keeper intervals must be at least 60000ms");
  }
  return Math.floor(intervalMs);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

function normalizeConcurrency(value, targetCount) {
  const concurrency = Number(value);
  if (!Number.isInteger(concurrency) || concurrency <= 0 || concurrency > 100) {
    throw new Error("ORACLE_SCRAPE_CONCURRENCY must be an integer between 1 and 100");
  }
  return Math.max(1, Math.min(concurrency, Math.max(1, targetCount)));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  allowPlaywrightFallback,
  allowPlaywrightScraping,
  assertPlaywrightPermission,
  buildPl500IndexQuote,
  crossSourceStatus,
  extractMarketPrice,
  isKeeperActionDue,
  mapWithConcurrency,
  normalizeConcurrency,
  oraclePrimarySource,
  selectPricedSku,
  selectOracleQuote,
  scrapeCycle,
  tcgplayerSourceMode,
  validateSourceConfiguration,
  withRefreshChange
};
