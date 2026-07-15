const { createDatabase } = require("../server/db.cjs");
const { readinessReport } = require("../server/readiness.cjs");

async function main() {
  const { network, pool } = createDatabase(process.env.CHAIN_ID);
  try {
    const report = await readinessReport(pool, network);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    if (!report.ready) process.exitCode = 1;
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
