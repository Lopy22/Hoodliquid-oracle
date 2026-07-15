const { expect } = require("chai");
const { readinessReport } = require("../server/readiness.cjs");

describe("Oracle readiness", function () {
  const now = Date.parse("2026-07-15T00:00:00.000Z");
  const network = { chainId: 46630, key: "robinhood-testnet" };
  const originalSource = process.env.ORACLE_TCGPLAYER_SOURCE;
  const originalHl500 = process.env.ORACLE_HL500_ENABLED;

  beforeEach(function () {
    process.env.ORACLE_TCGPLAYER_SOURCE = "api";
    process.env.ORACLE_HL500_ENABLED = "false";
  });

  after(function () {
    if (originalSource === undefined) delete process.env.ORACLE_TCGPLAYER_SOURCE;
    else process.env.ORACLE_TCGPLAYER_SOURCE = originalSource;
    if (originalHl500 === undefined) delete process.env.ORACLE_HL500_ENABLED;
    else process.env.ORACLE_HL500_ENABLED = originalHl500;
  });

  it("requires PostgreSQL, a recent successful cycle, and fresh enabled marks", async function () {
    const pool = readinessPool({
      runRows: [{
        finished_at: new Date(now - 60_000),
        details: { successfulMarkets: 6 }
      }],
      marketRows: [{
        market_id: "CHARIZARD-X",
        observed_at: new Date(now - 120_000)
      }]
    });
    const report = await readinessReport(pool, network, { nowMs: now });
    expect(report.ready).to.equal(true);
    expect(report.checks).to.deep.equal({
      sourceConfiguration: true,
      postgres: true,
      ingestion: true,
      marks: true
    });
  });

  it("reports a missing ingestion cycle and stale marks", async function () {
    const pool = readinessPool({
      runRows: [],
      marketRows: [{ market_id: "CHARIZARD-X", observed_at: null }]
    });
    const report = await readinessReport(pool, network, { nowMs: now });
    expect(report.ready).to.equal(false);
    expect(report.failures.join(" ")).to.contain("No successful ingestion cycle");
    expect(report.failures.join(" ")).to.contain("CHARIZARD-X");
  });
});

function readinessPool({ runRows, marketRows }) {
  return {
    async query(sql) {
      if (sql === "SELECT 1") return { rowCount: 1, rows: [{ "?column?": 1 }] };
      if (sql.includes("FROM worker_runs")) {
        return { rowCount: runRows.length, rows: runRows };
      }
      if (sql.includes("FROM markets m")) {
        return { rowCount: marketRows.length, rows: marketRows };
      }
      throw new Error("Unexpected readiness query: " + sql);
    }
  };
}
