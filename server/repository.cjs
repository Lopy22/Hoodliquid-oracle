const { jsonSafe } = require("./db.cjs");

async function recordWorkerRun(pool, worker, callback) {
  const start = await pool.query(
    "INSERT INTO worker_runs(worker) VALUES ($1) RETURNING id",
    [worker]
  );
  const id = start.rows[0].id;
  try {
    const details = jsonSafe(await callback());
    await pool.query(
      "UPDATE worker_runs SET finished_at=now(),success=true,details=$2 WHERE id=$1",
      [id, details || {}]
    );
    return details;
  } catch (error) {
    await pool.query(
      "UPDATE worker_runs SET finished_at=now(),success=false,details=$2 WHERE id=$1",
      [id, { error: error instanceof Error ? error.message : String(error) }]
    );
    throw error;
  }
}

module.exports = { recordWorkerRun };
