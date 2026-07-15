const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const ROOT = path.join(__dirname, "..");

function loadEnvironment() {
  if (process.env.ENV_FILE) {
    dotenv.config({ path: path.resolve(process.env.ENV_FILE), quiet: true });
  } else {
    dotenv.config({ path: path.join(ROOT, ".env.local"), quiet: true });
    if (process.env.NODE_ENV === "production") {
      dotenv.config({ path: path.join(ROOT, ".env.production"), quiet: true });
    }
    dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
  }
}

loadEnvironment();

const catalog = JSON.parse(
  fs.readFileSync(path.join(ROOT, "config", "networks.json"), "utf8")
);

function getNetwork(chainIdInput = process.env.CHAIN_ID) {
  const chainId = Number(chainIdInput);
  const network = catalog.networks.find((entry) => entry.chainId === chainId);
  if (!network) {
    throw new Error("CHAIN_ID must be 4663 or 46630; received " + (chainIdInput || "empty"));
  }
  return {
    ...network,
    databaseUrl: process.env.DATABASE_URL || "",
    apiPort: positiveInteger(process.env.PORT || 8080, "PORT"),
    host: process.env.HOST || "127.0.0.1"
  };
}

function supportedChainIds() {
  return catalog.networks.map((entry) => entry.chainId);
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > 65535) {
    throw new Error(name + " must be a positive integer");
  }
  return number;
}

module.exports = { ROOT, getNetwork, loadEnvironment, supportedChainIds };
