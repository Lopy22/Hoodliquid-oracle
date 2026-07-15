const { validateSourceConfiguration } = require("../scripts/scrape-tcgplayer-prices.cjs");

async function readinessReport(pool, network, options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const scrapeIntervalMs = Number(process.env.ORACLE_SCRAPE_INTERVAL_MS || 60_000);
  const workerMaxAgeSeconds = Number(
    process.env.ORACLE_WORKER_MAX_AGE_SECONDS
    || Math.max(300, Math.ceil(scrapeIntervalMs * 3 / 1_000))
  );
  const markMaxAgeSeconds = Number(process.env.ORACLE_MARK_MAX_AGE_SECONDS || 1_800);
  const checks = {
    sourceConfiguration: false,
    postgres: false,
    ingestion: false,
    marks: false
  };
  const failures = [];

  try {
    validateSourceConfiguration();
    checks.sourceConfiguration = true;
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  try {
    await pool.query("SELECT 1");
    checks.postgres = true;
  } catch (error) {
    failures.push("PostgreSQL unavailable: " + (error instanceof Error ? error.message : String(error)));
    return {
      ready: false,
      chainId: network.chainId,
      checks,
      failures,
      checkedAt: new Date(nowMs).toISOString()
    };
  }

  let run;
  let markets;
  try {
    run = await pool.query(
      "SELECT finished_at,details FROM worker_runs "
      + "WHERE worker='market-data' AND success=true AND finished_at IS NOT NULL "
      + "ORDER BY finished_at DESC LIMIT 1"
    );
    markets = await pool.query(
      "SELECT m.market_id,o.observed_at FROM markets m "
      + "LEFT JOIN oracle_marks o ON o.market_id=m.market_id WHERE m.live=true ORDER BY m.market_id"
    );
  } catch (error) {
    failures.push(
      "Oracle schema unavailable; run npm run db:migrate: "
      + (error instanceof Error ? error.message : String(error))
    );
    return {
      ready: false,
      chainId: network.chainId,
      checks,
      failures,
      checkedAt: new Date(nowMs).toISOString()
    };
  }

  if (!run.rowCount) {
    failures.push("No successful ingestion cycle has completed");
  } else {
    const age = Math.floor((nowMs - new Date(run.rows[0].finished_at).getTime()) / 1_000);
    checks.ingestion = age >= 0 && age <= workerMaxAgeSeconds;
    if (!checks.ingestion) {
      failures.push("Latest successful ingestion cycle is " + age + "s old");
    }
  }

  if (!markets.rowCount) {
    failures.push("No enabled markets are registered");
  } else {
    const stale = markets.rows.filter((row) => {
      if (!row.observed_at) return true;
      const age = Math.floor((nowMs - new Date(row.observed_at).getTime()) / 1_000);
      return age < 0 || age > markMaxAgeSeconds;
    }).map((row) => row.market_id);
    checks.marks = stale.length === 0;
    if (stale.length) failures.push("Missing or stale accepted marks: " + stale.join(", "));
  }

  return {
    ready: Object.values(checks).every(Boolean),
    chainId: network.chainId,
    checks,
    failures,
    workerMaxAgeSeconds,
    markMaxAgeSeconds,
    checkedAt: new Date(nowMs).toISOString()
  };
}

module.exports = { readinessReport };
