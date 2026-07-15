const path = require("node:path");
const dotenv = require("dotenv");

const cwd = path.join(__dirname, "..");
dotenv.config({
  path: process.env.ENV_FILE
    ? path.resolve(process.env.ENV_FILE)
    : path.join(cwd, ".env.production"),
  quiet: true
});
const chainId = Number(process.env.CHAIN_ID);
if (![4663, 46630].includes(chainId)) {
  throw new Error("CHAIN_ID in the PM2 environment file must be 4663 or 46630");
}
const suffix = chainId === 4663 ? "rh-mainnet" : "rh-testnet";

module.exports = {
  apps: [
    {
      name: "hoodliquid-oracle-api-" + suffix,
      cwd,
      script: "server/api.cjs",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "512M",
      time: true,
      env: {
        NODE_ENV: "production",
        PM2_PROCESS_NAME: "hoodliquid-oracle-api-" + suffix
      }
    },
    {
      name: "hoodliquid-oracle-ingest-" + suffix,
      cwd,
      script: "server/workers/market-data.cjs",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "1G",
      time: true,
      env: {
        NODE_ENV: "production",
        PM2_PROCESS_NAME: "hoodliquid-oracle-ingest-" + suffix
      }
    }
  ]
};
