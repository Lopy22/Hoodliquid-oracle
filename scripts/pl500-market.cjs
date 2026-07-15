const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ path: ".env.local", quiet: true });
require("dotenv").config({ quiet: true });

const DEFAULT_CONSTITUENTS_PATH = "data/oracle/pl500-constituents.json";
const DEFAULT_POKELIQUID_BASE_URL = "https://www.pokeliquid.xyz/api/keeper";
const DEFAULT_MAX_AGE_SECONDS = 15 * 60;
const DEFAULT_TIMEOUT_MS = 10_000;

function pl500Source() {
  const source = String(process.env.ORACLE_PL500_SOURCE || "pokeliquid-api").trim().toLowerCase();
  if (!["pokeliquid-api", "constituents", "disabled"].includes(source)) {
    throw new Error("ORACLE_PL500_SOURCE must be pokeliquid-api, constituents, or disabled");
  }
  return source;
}

function pl500MappingStatus(configured = process.env.ORACLE_PL500_CONSTITUENTS || DEFAULT_CONSTITUENTS_PATH) {
  const filePath = path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const rows = Array.isArray(parsed.constituents) ? parsed.constituents : [];
  const usable = rows.filter((row) => row.snapshotOnly ? Number(row.seedPriceUsd) > 0 : Number(row.tcgplayerId) > 0).length;
  const snapshots = rows.filter((row) => row.snapshotOnly === true).length;
  return {
    count: rows.length,
    usable,
    snapshots,
    ready: rows.length === 500 && usable === 500 && snapshots === 8
  };
}

function isPl500MarketLive(chainId) {
  const numericChainId = Number(chainId);
  const source = pl500Source();
  if (numericChainId === 46630) {
    return source === "pokeliquid-api" || source === "constituents" && pl500MappingStatus().ready;
  }
  if (numericChainId === 4663) {
    return source === "constituents" && pl500MappingStatus().ready;
  }
  return false;
}

async function fetchPokeliquidPl500Quote({
  now = Math.floor(Date.now() / 1000),
  fetchImpl = fetch,
  baseUrl = process.env.ORACLE_POKELIQUID_BASE_URL || DEFAULT_POKELIQUID_BASE_URL,
  maxAgeSeconds = Number(process.env.ORACLE_POKELIQUID_MAX_AGE_SECONDS || DEFAULT_MAX_AGE_SECONDS),
  timeoutMs = Number(process.env.ORACLE_POKELIQUID_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)
} = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, "")}/prices?market=PL500&limit=1`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "HoodLiquid-Oracle/2" },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response?.ok) throw new Error(`PokeLiquid PL500 API returned HTTP ${response?.status || "unknown"}`);
  const payload = await response.json();
  const rows = Array.isArray(payload) ? payload : [];
  const latest = rows
    .filter((row) => Number.isFinite(Number(row?.timestamp)))
    .sort((left, right) => Number(right.timestamp) - Number(left.timestamp))[0];
  if (!latest) throw new Error("PokeLiquid PL500 API returned no observations");

  const observedAt = Number(latest.timestamp);
  const rawPriceUsd = Number(latest.raw_price);
  const upstreamEwmaUsd = Number(latest.ewma);
  const transactionSignature = String(latest.tx_signature || "");
  if (!Number.isInteger(observedAt) || observedAt <= 0) throw new Error("PokeLiquid PL500 observation timestamp is invalid");
  if (observedAt > now + 300) throw new Error("PokeLiquid PL500 observation is too far in the future");
  if (now - observedAt > maxAgeSeconds) throw new Error(`PokeLiquid PL500 observation is stale by ${now - observedAt}s`);
  if (!Number.isFinite(rawPriceUsd) || rawPriceUsd <= 0 || !Number.isFinite(upstreamEwmaUsd) || upstreamEwmaUsd <= 0) {
    throw new Error("PokeLiquid PL500 observation has an invalid price");
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{60,100}$/.test(transactionSignature)) {
    throw new Error("PokeLiquid PL500 observation is missing a valid Solana transaction signature");
  }

  return {
    source: "pokeliquid-api",
    observedAt,
    rawPriceUsd,
    upstreamEwmaUsd,
    transactionSignature,
    upstreamId: Number(latest.id || 0) || null,
    upstreamDeviation: Number(latest.deviation || 0),
    upstreamAlpha: Number(latest.alpha || 0),
    sourceUrl: url
  };
}

module.exports = {
  DEFAULT_POKELIQUID_BASE_URL,
  fetchPokeliquidPl500Quote,
  isPl500MarketLive,
  pl500MappingStatus,
  pl500Source
};
