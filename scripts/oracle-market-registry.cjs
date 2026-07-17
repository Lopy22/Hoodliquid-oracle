const fs = require("fs");
const path = require("path");

const DEFAULT_MARKET_REGISTRY_PATH = "data/oracle/market-registry.json";

function loadOracleMarketRegistry(configured = process.env.ORACLE_MARKET_REGISTRY || DEFAULT_MARKET_REGISTRY_PATH) {
  const registryPath = path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  validateOracleMarketRegistry(registry, registryPath);
  return registry;
}

function validateOracleMarketRegistry(registry, registryPath = DEFAULT_MARKET_REGISTRY_PATH) {
  if (!registry || registry.version !== 1) {
    throw new Error(`Oracle market registry ${registryPath} must have version 1`);
  }
  if (!Array.isArray(registry.markets) || registry.markets.length === 0) {
    throw new Error(`Oracle market registry ${registryPath} must define markets[]`);
  }

  const ids = new Set();
  const priceKeys = new Set();
  const productIds = new Set();
  for (const market of registry.markets) {
    requireField(market, "id", registryPath);
    requireField(market, "symbol", registryPath);
    requireField(market, "priceApiMarket", registryPath);
    requireField(market, "type", registryPath);

    if (ids.has(market.id)) throw new Error(`Duplicate oracle registry id ${market.id}`);
    if (priceKeys.has(market.priceApiMarket)) throw new Error(`Duplicate oracle registry priceApiMarket ${market.priceApiMarket}`);
    ids.add(market.id);
    priceKeys.add(market.priceApiMarket);

    const floor = Number(market.priceFloorUsd);
    if (!Number.isFinite(floor) || floor <= 0) {
      throw new Error(`Oracle registry market ${market.priceApiMarket} needs a positive priceFloorUsd`);
    }
    const maxOpenInterestEth = Number(market.maxOpenInterestEth);
    if (!Number.isFinite(maxOpenInterestEth) || maxOpenInterestEth <= 0) {
      throw new Error(`Oracle registry market ${market.priceApiMarket} needs a positive maxOpenInterestEth`);
    }

    if (market.type === "CARDS") {
      if (!Number.isInteger(Number(market.tcgplayerId)) || Number(market.tcgplayerId) <= 0) {
        throw new Error(`Card market ${market.priceApiMarket} needs a TCGPlayer product id`);
      }
      if (productIds.has(Number(market.tcgplayerId))) {
        throw new Error(`Duplicate TCGPlayer product id ${market.tcgplayerId}`);
      }
      productIds.add(Number(market.tcgplayerId));
      requireField(market, "conditionName", registryPath);
      requirePositiveInteger(market, "conditionId", registryPath);
      requirePositiveInteger(market, "languageId", registryPath);
      requireField(market, "tcgplayerUrl", registryPath);
      if (!Array.isArray(market.sourcePriority) || !market.sourcePriority.some((source) => source === "tcgplayer-playwright" || source === "tcgplayer-api")) {
        throw new Error(`Card market ${market.priceApiMarket} must include a TCGPlayer source in sourcePriority`);
      }
    }

    if (market.type === "INDEX") {
      if (!market.oracle || market.oracle.kind !== "fixed-basket-index") {
        throw new Error(`${market.priceApiMarket} must declare oracle.kind fixed-basket-index`);
      }
      requireField(market.oracle, "constituentsPath", registryPath);
      requirePositiveInteger(market.oracle, "targetConstituents", registryPath);
      const targetConstituents = Number(market.oracle.targetConstituents);
      const apiPricedTargetCount = Number(market.oracle.apiPricedTargetCount);
      const snapshotExceptionTargetCount = Number(market.oracle.snapshotExceptionTargetCount);
      if (!Number.isInteger(apiPricedTargetCount) || apiPricedTargetCount < 0) {
        throw new Error(`${market.priceApiMarket} oracle.apiPricedTargetCount must be a non-negative integer`);
      }
      if (!Number.isInteger(snapshotExceptionTargetCount) || snapshotExceptionTargetCount < 0) {
        throw new Error(`${market.priceApiMarket} oracle.snapshotExceptionTargetCount must be a non-negative integer`);
      }
      if (apiPricedTargetCount + snapshotExceptionTargetCount !== targetConstituents) {
        throw new Error(`${market.priceApiMarket} live mapping and snapshot targets must equal targetConstituents`);
      }
    }
  }

  const liveIndexMarkets = registry.markets.filter((market) => market.type === "INDEX" && market.live !== false);
  if (liveIndexMarkets.length > 1) {
    throw new Error(`Oracle market registry ${registryPath} must define at most one live INDEX market`);
  }

  return true;
}

function liveIndexMarket(registry = loadOracleMarketRegistry()) {
  return registry.markets.find((market) => market.type === "INDEX" && market.live !== false) || null;
}

function activeRegistryMarkets(registry = loadOracleMarketRegistry()) {
  return registry.markets.filter((market) => market.live !== false);
}

function cardOracleTargets(registry = loadOracleMarketRegistry()) {
  const defaults = registry.defaultCondition || {};
  return activeRegistryMarkets(registry)
    .filter((market) => market.type === "CARDS")
    .map((market) => ({
      priceKey: market.priceApiMarket,
      tcgplayerId: Number(market.tcgplayerId),
      card: market.card || market.displayName || market.id,
      set: market.set || "",
      seedPriceUsd: Number(market.seedPriceUsd || 0),
      snapshotOnly: Boolean(market.snapshotOnly),
      group: market.group,
      poketraceEligible: Boolean(market.poketraceEligible),
      conditionName: market.conditionName || defaults.conditionName,
      conditionId: Number(market.conditionId || defaults.conditionId || 0),
      languageId: Number(market.languageId || defaults.languageId || 0),
      tcgplayerUrl: market.tcgplayerUrl,
      priceFloorUsd: Number(market.priceFloorUsd)
    }));
}

function perpSeedMarkets(registry = loadOracleMarketRegistry()) {
  return activeRegistryMarkets(registry).map((market) => [
    market.priceApiMarket,
    market.symbol,
    market.priceApiMarket,
    Number(market.maxLeverage || 25),
    Number(market.maxOpenInterestEth || 25)
  ]);
}

function registryPriceFloors(registry = loadOracleMarketRegistry()) {
  return Object.fromEntries(activeRegistryMarkets(registry).map((market) => [market.priceApiMarket, Number(market.priceFloorUsd)]));
}

function registryMarketMap(registry = loadOracleMarketRegistry()) {
  return new Map(activeRegistryMarkets(registry).map((market) => [market.priceApiMarket, market]));
}

function requireField(target, field, registryPath) {
  if (target[field] === undefined || target[field] === null || target[field] === "") {
    throw new Error(`Oracle market registry ${registryPath} missing ${field}`);
  }
}

function requirePositiveInteger(target, field, registryPath) {
  const value = Number(target[field]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Oracle market registry ${registryPath} needs positive integer ${field}`);
  }
}

module.exports = {
  DEFAULT_MARKET_REGISTRY_PATH,
  activeRegistryMarkets,
  cardOracleTargets,
  liveIndexMarket,
  loadOracleMarketRegistry,
  perpSeedMarkets,
  registryMarketMap,
  registryPriceFloors,
  validateOracleMarketRegistry
};
