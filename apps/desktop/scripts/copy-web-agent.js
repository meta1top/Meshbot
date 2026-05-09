const fs = require("node:fs");
const path = require("node:path");

const src = path.resolve(__dirname, "..", "..", "web-agent", "out");
const dest = path.resolve(__dirname, "..", "dist", "web-agent");

if (!fs.existsSync(src)) {
  console.error("[copy-web-agent] Source not found:", src);
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true, force: true });
console.log("[copy-web-agent] Copied", src, "->", dest);
