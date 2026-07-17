const os = require("node:os");
const { withAdvisoryLock } = require("../db.cjs");
const { recordWorkerRun } = require("../repository.cjs");
const { logger } = require("../logger.cjs");

async function runWorker({ pool, network, name, intervalMs, run }) {
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });

  await withAdvisoryLock(pool, network.chainId, name, async (_lockClient, heartbeat) => {
    logger.info({ worker: name, network: network.key, hostname: os.hostname() }, "Worker leader active");
    while (!stopping) {
      const started = Date.now();
      try {
        const details = await recordWorkerRun(pool, name, () => run());
        await heartbeat({ lastSuccessAt: new Date().toISOString(), details });
      } catch (error) {
        logger.error({ err: error, worker: name, network: network.key }, "Worker cycle failed");
        await heartbeat({ lastErrorAt: new Date().toISOString(), lastError: error instanceof Error ? error.message : String(error) });
        if (process.argv.includes("--once")) throw error;
      }
      if (stopping || process.argv.includes("--once")) break;
      await interruptibleDelay(Math.max(1_000, intervalMs - (Date.now() - started)), () => stopping);
    }
  });
}

async function interruptibleDelay(ms, stopped) {
  let remaining = ms;
  while (remaining > 0 && !stopped()) {
    const slice = Math.min(5_000, remaining);
    await new Promise((resolve) => setTimeout(resolve, slice));
    remaining -= slice;
  }
}

function argument(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

module.exports = { argument, runWorker };
