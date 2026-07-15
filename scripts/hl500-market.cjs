const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ path: ".env.local", quiet: true });
if (process.env.NODE_ENV === "production") {
  require("dotenv").config({ path: ".env.production", quiet: true });
}
require("dotenv").config({ quiet: true });

const DEFAULT_CONSTITUENTS_PATH = "data/oracle/hl500-constituents.json";

function hl500MappingStatus(
  configured = process.env.ORACLE_HL500_CONSTITUENTS || DEFAULT_CONSTITUENTS_PATH
) {
  const filePath = path.isAbsolute(configured)
    ? configured
    : path.join(process.cwd(), configured);
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const rows = Array.isArray(parsed.constituents) ? parsed.constituents : [];
  const mapped = rows.filter((row) => row.snapshotOnly !== true && Number(row.tcgplayerId) > 0).length;
  const snapshots = rows.filter((row) => row.snapshotOnly === true).length;
  const usable = rows.filter((row) => (
    row.snapshotOnly
      ? Number(row.seedPriceUsd) > 0
      : Number(row.tcgplayerId) > 0
  )).length;
  return {
    count: rows.length,
    mapped,
    usable,
    snapshots,
    missing: Math.max(0, 500 - usable),
    ready: rows.length === 500 && mapped === 492 && usable === 500 && snapshots === 8
  };
}

function isHl500MarketLive(chainId) {
  const supported = [4663, 46630].includes(Number(chainId));
  const enabled = process.env.ORACLE_HL500_ENABLED !== "false";
  return supported && enabled && hl500MappingStatus().ready;
}

module.exports = {
  DEFAULT_CONSTITUENTS_PATH,
  hl500MappingStatus,
  isHl500MarketLive
};
