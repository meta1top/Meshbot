#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const bundleDir = path.join(repoRoot, "apps", "server-agent", ".bundle");
// Windows: avoid pnpm deploy mixing D:\repo with C:\Temp (breaks workspace symlinks).
const tempDir =
  process.platform === "win32"
    ? path.join(repoRoot, ".anybot-server-bundle-deploy")
    : path.join(os.tmpdir(), "anybot-server-bundle");

function rmRf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function removeBrokenSymlinks(root) {
  if (!fs.existsSync(root)) return;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isSymbolicLink()) {
        try {
          fs.statSync(full);
        } catch {
          try {
            fs.unlinkSync(full);
          } catch {
            /* ignore */
          }
        }
      }
    }
  };
  walk(root);
}

function runPnpmDeploy() {
  const args = [
    "--filter",
    "@anybot/server-agent",
    "deploy",
    "--legacy",
    "--prod",
    tempDir,
  ];
  const env = {
    ...process.env,
    PNPM_REPORTER: process.env.PNPM_REPORTER ?? "append-only",
  };
  const r = spawnSync("pnpm", args, {
    cwd: repoRoot,
    stdio: "inherit",
    env,
    shell: process.platform === "win32",
  });
  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }
  const code = r.status ?? 1;
  if (code !== 0) process.exit(code);
}

function main() {
  console.log("[prepare-server-agent] repo:", repoRoot);
  console.log("[prepare-server-agent] bundle:", bundleDir);
  console.log("[prepare-server-agent] temp:", tempDir);

  rmRf(bundleDir);
  rmRf(tempDir);

  runPnpmDeploy();

  removeBrokenSymlinks(tempDir);

  rmRf(bundleDir);
  fs.cpSync(tempDir, bundleDir, { recursive: true });

  rmRf(tempDir);
  console.log("[prepare-server-agent] done.");
}

main();
