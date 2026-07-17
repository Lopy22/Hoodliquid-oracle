const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createDatabase } = require("../server/db.cjs");
const { liveIndexMarket } = require("./oracle-market-registry.cjs");

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const indexMarket = liveIndexMarket();
  if (!indexMarket) throw new Error("The oracle market registry has no live INDEX market");
  const list = loadConstituents(indexMarket);
  const ids = await selectTargets({ ...options, list });
  if (ids.length === 0) {
    console.log(`No ${options.allStale ? "stale" : "stale or never-priced"} ${indexMarket.priceApiMarket} constituents to refresh.`);
    return;
  }
  console.log(`[refresh] Network: ${options.chainId}; market: ${indexMarket.priceApiMarket}; freshness threshold: ${freshnessSeconds()}s`);
  console.log(`[refresh] Selected ${ids.length} constituent(s): ${ids.join(",")}`);
  await logCurrentStates(options.chainId, ids);
  console.log("[refresh] Starting targeted ingestion. Live source and acceptance logs follow.");
  const startedAt = Date.now();
  await runIngestion(options.chainId, ids);
  console.log("[refresh] Verifying the accepted constituent state after ingestion.");
  const states = await logCurrentStates(options.chainId, ids);
  const unresolved = states.filter((state) => !state.fresh);
  if (unresolved.length > 0) {
    throw new Error(`Refresh completed, but ${unresolved.map((state) => state.id).join(",")} still need a fresh accepted observation`);
  }
  console.log(`[refresh] Targeted ingestion completed successfully in ${Math.round((Date.now() - startedAt) / 1_000)}s.`);
}

function parseArguments(args) {
  const chainId = Number(argument(args, "chain-id") || process.env.CHAIN_ID || 46630);
  if (![4663, 46630].includes(chainId)) throw new Error("--chain-id must be 4663 or 46630");
  const market = argument(args, "market");
  const allStale = args.includes("--all-stale");
  const repair = args.includes("--repair");
  if (Number(Boolean(market)) + Number(allStale) + Number(repair) !== 1) {
    throw new Error("Provide exactly one of --market=HL500-###, --all-stale, or --repair");
  }
  return { chainId, market, allStale, repair };
}

function argument(args, name) {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function loadConstituents(indexMarket) {
  const configured = process.env.ORACLE_INDEX_CONSTITUENTS || indexMarket.oracle.constituentsPath;
  const filePath = path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured);
  const list = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(list.constituents) || list.constituents.length === 0) {
    throw new Error(`No constituents found in ${filePath}`);
  }
  return list;
}

async function selectTargets({ chainId, market, allStale, repair, list }) {
  const constituentIds = list.constituents.map((row) => row.id);
  if (market) {
    if (!constituentIds.includes(market)) throw new Error(`Unknown live-index constituent: ${market}`);
    return [market];
  }

  const { pool } = createDatabase(chainId);
  try {
    const prefix = String(constituentIds[0]).replace(/\d+$/, "");
    const observations = await pool.query(
      `SELECT DISTINCT ON (market_id) market_id,observed_at
       FROM source_observations
       WHERE accepted=true AND market_id LIKE $1
       ORDER BY market_id,observed_at DESC`,
      [`${prefix}%`]
    );
    const observedAt = new Map(observations.rows.map((row) => [row.market_id, new Date(row.observed_at).getTime()]));
    const staleBefore = Date.now() - freshnessSeconds() * 1_000;
    return constituentIds.filter((id) => {
      const timestamp = observedAt.get(id);
      const missing = !timestamp;
      const stale = timestamp && timestamp < staleBefore;
      return allStale ? Boolean(stale) : Boolean(missing || stale);
    });
  } finally {
    await pool.end();
  }
}

async function logCurrentStates(chainId, ids) {
  const { pool } = createDatabase(chainId);
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (market_id) market_id,observed_at,source
       FROM source_observations
       WHERE accepted=true AND market_id = ANY($1::text[])
       ORDER BY market_id,observed_at DESC`,
      [ids]
    );
    const latest = new Map(result.rows.map((row) => [row.market_id, row]));
    const now = Date.now();
    return ids.map((id) => {
      const row = latest.get(id);
      if (!row) {
        console.log(`[refresh] ${id}: never accepted; requesting its first real observation.`);
        return { id, fresh: false, state: "never accepted", ageSeconds: null };
      }
      const ageSeconds = Math.max(0, Math.floor((now - new Date(row.observed_at).getTime()) / 1_000));
      const fresh = ageSeconds <= freshnessSeconds();
      const state = fresh ? "fresh" : "carried/stale";
      console.log(`[refresh] ${id}: ${state}; last accepted ${ageSeconds}s ago from ${row.source}.`);
      return { id, fresh, state, ageSeconds, source: row.source };
    });
  } finally {
    await pool.end();
  }
}

function freshnessSeconds() {
  const value = Number(process.env.ORACLE_INDEX_FRESHNESS_SECONDS || 1_800);
  if (!Number.isInteger(value) || value <= 0) throw new Error("ORACLE_INDEX_FRESHNESS_SECONDS must be a positive integer");
  return value;
}

function runIngestion(chainId, marketIds) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server/workers/market-data.cjs", `--chain-id=${chainId}`, "--once"], {
      cwd: process.cwd(),
      env: { ...process.env, ORACLE_MARKETS: marketIds.join(","), ORACLE_VERBOSE: "true" },
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`Targeted ingestion failed (${signal || `exit ${code}`})`));
    });
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = { freshnessSeconds, loadConstituents, logCurrentStates, parseArguments, selectTargets };
