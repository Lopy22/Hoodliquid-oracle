const { expect } = require("chai");
const { Client, Pool } = require("pg");

const enabled = process.env.RUN_POSTGRES_TESTS === "true";
const describePostgres = enabled ? describe : describe.skip;

describePostgres("PostgreSQL oracle integration", function () {
  this.timeout(30_000);
  let pool;
  let migrate;
  let worker;
  let database;

  before(async function () {
    const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
    if (!url) throw new Error("TEST_DATABASE_URL is required");
    process.env.DATABASE_URL = url;
    process.env.CHAIN_ID = "46630";
    process.env.ORACLE_TCGPLAYER_SOURCE = "api";
    process.env.ORACLE_PL500_SOURCE = "disabled";
    database = new URL(url).pathname.slice(1);
    if (!/test/i.test(database)) {
      throw new Error("Refusing to reset a database whose name does not contain 'test'");
    }
    const client = new Client({ connectionString: url });
    await client.connect();
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.end();

    ({ migrate } = require("../../server/migrate.cjs"));
    worker = require("../../server/workers/market-data.cjs");
    await migrate(46630);
    pool = new Pool({ connectionString: url });
    await worker.syncMarkets(pool, 46630);
  });

  after(async function () {
    if (pool) await pool.end();
  });

  it("creates only the oracle schema and monthly partitions", async function () {
    const tables = await pool.query(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
    );
    const names = tables.rows.map((row) => row.tablename);
    for (const required of [
      "markets",
      "source_observations",
      "source_state",
      "oracle_marks",
      "oracle_mark_history",
      "candles",
      "worker_leases",
      "worker_runs"
    ]) {
      expect(names).to.include(required);
    }
    expect(names).not.to.include("deployments");
    expect(names.some((name) => name.startsWith("source_observations_"))).to.equal(true);
  });

  it("enforces one advisory-lock leader", async function () {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const first = workerLock(async () => {
      entered();
      await held;
    });
    await started;
    await expect(workerLock(async () => {})).to.be.rejectedWith("active leader");
    release();
    await first;
  });

  it("persists a recorded cycle atomically and idempotently", async function () {
    const scrape = fixtureScrape(1_800_000_000, 854_250_000);
    await worker.ingestCycle(pool, 46630, scrape);
    await worker.ingestCycle(pool, 46630, scrape);
    const [observations, history, candles, mark] = await Promise.all([
      pool.query("SELECT count(*)::int AS count FROM source_observations WHERE market_id='CHARIZARD-X'"),
      pool.query("SELECT count(*)::int AS count FROM oracle_mark_history WHERE market_id='CHARIZARD-X'"),
      pool.query("SELECT interval_seconds,observations FROM candles WHERE market_id='CHARIZARD-X' ORDER BY interval_seconds"),
      pool.query("SELECT price,observed_at FROM oracle_marks WHERE market_id='CHARIZARD-X'")
    ]);
    expect(observations.rows[0].count).to.equal(1);
    expect(history.rows[0].count).to.equal(1);
    expect(candles.rows).to.have.length(3);
    expect(candles.rows.every((row) => row.observations === 1)).to.equal(true);
    expect(mark.rows[0].price).to.equal("854250000");
  });

  it("never replaces a mark with an older observation", async function () {
    await worker.ingestCycle(pool, 46630, fixtureScrape(1_799_999_000, 100_000_000));
    const mark = await pool.query(
      "SELECT price,extract(epoch from observed_at)::bigint AS observed_at "
      + "FROM oracle_marks WHERE market_id='CHARIZARD-X'"
    );
    expect(mark.rows[0].price).to.equal("854250000");
    expect(mark.rows[0].observed_at).to.equal("1800000000");
  });

  it("rolls back observations if mark persistence fails", async function () {
    await pool.query(
      "CREATE OR REPLACE FUNCTION fail_test_mark() RETURNS trigger LANGUAGE plpgsql AS $$ "
      + "BEGIN RAISE EXCEPTION 'forced mark failure'; END $$"
    );
    await pool.query(
      "CREATE TRIGGER fail_test_mark BEFORE INSERT OR UPDATE ON oracle_marks "
      + "FOR EACH ROW EXECUTE FUNCTION fail_test_mark()"
    );
    await expect(
      worker.ingestCycle(pool, 46630, fixtureScrape(1_800_001_000, 900_000_000))
    ).to.be.rejectedWith("forced mark failure");
    const observation = await pool.query(
      "SELECT count(*)::int AS count FROM source_observations "
      + "WHERE market_id='CHARIZARD-X' AND observed_at=to_timestamp(1800001000)"
    );
    expect(observation.rows[0].count).to.equal(0);
    await pool.query("DROP TRIGGER fail_test_mark ON oracle_marks");
    await pool.query("DROP FUNCTION fail_test_mark()");
  });

  it("removes raw minute data older than 90 days while retaining aggregates", async function () {
    await pool.query(
      "SELECT ensure_month_partition('source_observations',"
      + "(date_trunc('month',now()-interval '100 days'))::date)"
    );
    await pool.query(
      "INSERT INTO source_observations("
      + "market_id,source,raw_price,observed_at,source_hash,accepted"
      + ") VALUES ('CHARIZARD-X','fixture',1,now()-interval '100 days','old-fixture',true)"
    );
    await worker.enforceRetention(pool, true);
    const old = await pool.query(
      "SELECT count(*)::int AS count FROM source_observations WHERE source_hash='old-fixture'"
    );
    expect(old.rows[0].count).to.equal(0);
  });

  function workerLock(callback) {
    const { withAdvisoryLock } = require("../../server/db.cjs");
    return withAdvisoryLock(pool, 46630, "integration-lock", callback);
  }
});

function fixtureScrape(observedAt, price) {
  return async () => ({
    successfulMarkets: 1,
    targetCount: 1,
    failures: [],
    poketracePayload: { version: 1, prices: {} },
    payload: {
      prices: {
        "CHARIZARD-X": {
          price,
          rawPrice: price,
          lastUpdateTime: observedAt,
          sourceObservedAt: observedAt,
          source: "tcgplayer-api",
          independentSourceCount: 1,
          smoothing: { status: "accepted", tier: "direct", alpha: 1 }
        }
      }
    }
  });
}
