const { createDatabase } = require("../server/db.cjs");

async function main() {
  const { network, pool } = createDatabase(process.env.CHAIN_ID);
  try {
    const [markets, run, lease] = await Promise.all([
      pool.query(
        "SELECT m.market_id,m.live,o.price,o.source,o.confidence_bps,o.observed_at,"
        + "floor(extract(epoch from (now()-o.observed_at)))::bigint AS age_seconds "
        + "FROM markets m LEFT JOIN oracle_marks o ON o.market_id=m.market_id ORDER BY m.market_id"
      ),
      pool.query(
        "SELECT started_at,finished_at,success,details FROM worker_runs "
        + "WHERE worker='market-data' ORDER BY started_at DESC LIMIT 1"
      ),
      pool.query(
        "SELECT holder,heartbeat_at,metadata FROM worker_leases WHERE worker='market-data'"
      )
    ]);
    process.stdout.write(JSON.stringify({
      chainId: network.chainId,
      network: network.key,
      worker: run.rows[0] || null,
      lease: lease.rows[0] || null,
      markets: markets.rows
    }, null, 2) + "\n");
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
