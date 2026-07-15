const fs = require("node:fs");
const path = require("node:path");
const { createDatabase, withTransaction } = require("./db.cjs");

async function migrate(chainId = argument("chain-id") || process.env.CHAIN_ID) {
  const { network, pool } = createDatabase(chainId);
  const directory = path.join(__dirname, "migrations");
  const files = fs.readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const file of files) {
      const exists = await pool.query("SELECT 1 FROM schema_migrations WHERE version=$1", [file]);
      if (exists.rowCount) continue;
      await withTransaction(pool, async (client) => {
        await client.query(fs.readFileSync(path.join(directory, file), "utf8"));
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
      });
      console.log(`Applied ${file} to ${network.key}`);
    }
  } finally {
    await pool.end();
  }
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

if (require.main === module) {
  migrate().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { migrate };
