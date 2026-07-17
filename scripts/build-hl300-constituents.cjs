const fs = require("node:fs");
const path = require("node:path");

const SOURCE_PATH = "data/oracle/hl500-constituents.json";
const OUTPUT_PATH = "data/oracle/hl300-constituents.json";
const TARGET_COUNT = 300;
const EXPECTED_LAST_ID = "HL500-320";

// Rows excluded from HL300: one deliberately retired constituent followed by
// rows with reviewed-invalid TCGPlayer mappings.
const EXCLUDED_IDS = [
  "HL500-011",
  "HL500-055", "HL500-102", "HL500-140", "HL500-146", "HL500-152", "HL500-159",
  "HL500-169", "HL500-175", "HL500-180", "HL500-191", "HL500-241", "HL500-244",
  "HL500-259", "HL500-285", "HL500-288", "HL500-290", "HL500-314", "HL500-318",
  "HL500-389", "HL500-391", "HL500-403", "HL500-414", "HL500-433", "HL500-436",
  "HL500-439", "HL500-444", "HL500-446"
];

function deriveHl300(source) {
  const rows = Array.isArray(source.constituents) ? source.constituents : [];
  const rowIds = new Set(rows.map((row) => row.id));
  const missingExcluded = EXCLUDED_IDS.filter((id) => !rowIds.has(id));
  if (missingExcluded.length > 0) {
    throw new Error(`Excluded ids not found in ${SOURCE_PATH}: ${missingExcluded.join(", ")}`);
  }

  const excluded = new Set(EXCLUDED_IDS);
  const excludedDuplicateIds = [];
  const picked = [];
  for (const row of rows) {
    if (picked.length === TARGET_COUNT) break;
    if (excluded.has(row.id)) continue;
    if (row.duplicateOf) {
      excludedDuplicateIds.push(row.id);
      continue;
    }
    picked.push(row);
  }

  if (picked.length !== TARGET_COUNT) {
    throw new Error(`Expected ${TARGET_COUNT} constituents, derived ${picked.length}`);
  }
  const lastId = picked[picked.length - 1].id;
  if (lastId !== EXPECTED_LAST_ID) {
    throw new Error(`Expected last constituent ${EXPECTED_LAST_ID}, derived ${lastId}`);
  }
  const unmapped = picked.filter((row) => !(Number(row.tcgplayerId) > 0));
  if (unmapped.length > 0) {
    throw new Error(`Constituents without TCGPlayer mappings: ${unmapped.map((row) => row.id).join(", ")}`);
  }
  const productIds = picked.map((row) => Number(row.tcgplayerId));
  if (new Set(productIds).size !== picked.length) {
    throw new Error("Derived HL300 basket contains duplicate TCGPlayer product ids");
  }
  const seedTotalUsd = Math.round(picked.reduce((sum, row) => sum + Number(row.seedPriceUsd), 0) * 100) / 100;

  return {
    version: 1,
    source: "hoodliquid-hl300-constituent-seed",
    count: TARGET_COUNT,
    apiPricedTargetCount: TARGET_COUNT,
    snapshotExceptionTargetCount: 0,
    weightingMethod: source.weightingMethod || "equal-weight-per-row",
    duplicateIdentityPolicy: "no-duplicates",
    seedTotalUsd,
    derivedFrom: {
      path: SOURCE_PATH,
      excludedIds: EXCLUDED_IDS,
      excludedDuplicateIds
    },
    constituents: picked
  };
}

function main() {
  const sourcePath = path.join(process.cwd(), SOURCE_PATH);
  const outputPath = path.join(process.cwd(), OUTPUT_PATH);
  const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  const derived = deriveHl300(source);
  fs.writeFileSync(outputPath, `${JSON.stringify(derived, null, 2)}\n`);
  console.log(`Wrote ${derived.count} constituents (seed total $${derived.seedTotalUsd}) to ${OUTPUT_PATH}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { EXCLUDED_IDS, SOURCE_PATH, TARGET_COUNT, deriveHl300 };
