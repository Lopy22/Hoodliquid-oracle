const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: {
    service: process.env.PM2_PROCESS_NAME || "hoodliquid-oracle",
    pid: process.pid
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

module.exports = { logger };
