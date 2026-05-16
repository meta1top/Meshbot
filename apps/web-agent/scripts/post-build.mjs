#!/usr/bin/env node
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

const staticSource = join(projectRoot, ".next", "static");
const standaloneDir = join(
  projectRoot,
  ".next",
  "standalone",
  "apps",
  "web-agent",
);
const staticTarget = join(standaloneDir, ".next", "static");

if (!existsSync(staticSource) || !existsSync(standaloneDir)) {
  // export 模式或 standalone 未启用 — no-op safely
  process.exit(0);
}

cpSync(staticSource, staticTarget, { recursive: true });
console.log("[post-build] static assets copied to standalone");
