const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const forbiddenNames = [
  ".env",
  ".env.local",
  ".env.production",
  "prices.json",
  "history.json",
  "status.json",
  "tcgplayer-skus.json",
  "poketrace-cards.json",
  "poketrace-prices.json"
];
const forbiddenExtensions = [".dump", ".pem", ".key", ".p12", ".sql.gz"];
const files = trackedFiles();
const violations = [];

for (const relative of files) {
  const base = path.basename(relative);
  if (forbiddenNames.includes(base) || forbiddenExtensions.some((suffix) => relative.endsWith(suffix))) {
    violations.push(relative + ": forbidden generated or secret-bearing filename");
    continue;
  }
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) continue;
  if (!fs.statSync(absolute).isFile()) continue;
  const content = fs.readFileSync(absolute, "utf8");
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) {
    violations.push(relative + ": contains a private key block");
  }
  if (/^(?:PRIVATE_KEY|REPORTER_PRIVATE_KEY|RELAYER_PRIVATE_KEY)\s*=\s*\S+/m.test(content)) {
    violations.push(relative + ": contains a populated private-key environment value");
  }
}

if (violations.length) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Secret-pattern check passed for " + files.length + " files");
}

function trackedFiles() {
  if (!fs.existsSync(path.join(root, ".git"))) return walk(root);
  try {
    return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
  } catch {
    return walk(root);
  }
}

function walk(directory, prefix = "") {
  const entries = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(item.name)) continue;
    const relative = path.join(prefix, item.name);
    if (item.isDirectory()) entries.push(...walk(path.join(directory, item.name), relative));
    else entries.push(relative);
  }
  return entries;
}
