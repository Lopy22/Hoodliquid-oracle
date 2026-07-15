const crypto = require("node:crypto");
const os = require("node:os");
const { Pool, types } = require("pg");
const { getNetwork } = require("./config.cjs");
const { logger } = require("./logger.cjs");

types.setTypeParser(20, (value) => value);
types.setTypeParser(1700, (value) => value);

function createDatabase(chainId) {
  const network = getNetwork(chainId);
  if (!network.databaseUrl) throw new Error("DATABASE_URL is not configured");
  const pool = new Pool({
    connectionString: network.databaseUrl,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: process.env.PM2_PROCESS_NAME || "hoodliquid-oracle-" + network.key,
    ssl: process.env.PG_SSL === "true"
      ? { rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== "false" }
      : undefined
  });
  pool.on("error", (error) => logger.error({ err: error }, "PostgreSQL pool error"));
  return { network, pool };
}

async function withTransaction(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function withAdvisoryLock(pool, chainId, worker, callback) {
  const client = await pool.connect();
  const lockKey = advisoryKey(chainId, worker);
  const holder = os.hostname() + ":" + process.pid;
  let acquired = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [lockKey]);
    acquired = Boolean(lock.rows[0].acquired);
    if (!acquired) throw new Error(worker + " already has an active leader for chain " + chainId);
    await client.query(
      "INSERT INTO worker_leases(worker,holder,heartbeat_at,metadata) "
      + "VALUES ($1,$2,now(),$3) "
      + "ON CONFLICT (worker) DO UPDATE SET holder=EXCLUDED.holder,heartbeat_at=now(),metadata=EXCLUDED.metadata",
      [worker, holder, { chainId, pid: process.pid }]
    );
    return await callback(client, async (metadata = {}) => {
      await client.query(
        "UPDATE worker_leases SET heartbeat_at=now(),metadata=metadata || $2 WHERE worker=$1",
        [worker, metadata]
      );
    });
  } finally {
    if (acquired) {
      try { await client.query("SELECT pg_advisory_unlock($1)", [lockKey]); } catch {}
    }
    client.release();
  }
}

function advisoryKey(chainId, worker) {
  const digest = crypto.createHash("sha256").update(chainId + ":" + worker).digest();
  return digest.readBigInt64BE(0).toString();
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, entry) => (
    typeof entry === "bigint" ? entry.toString() : entry
  )));
}

module.exports = {
  advisoryKey,
  createDatabase,
  jsonSafe,
  withAdvisoryLock,
  withTransaction
};
