#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const bundleDir = path.join(repoRoot, "apps", "server-agent", ".bundle");

const DEPLOY_HEARTBEAT_MS = Number(process.env.ANYBOT_DEPLOY_HEARTBEAT_MS ?? 90_000);

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

function runPnpmDeploy(dest) {
  const args = [
    "--filter",
    "@anybot/server-agent",
    "deploy",
    "--legacy",
    "--prod",
    "--config.node-linker=hoisted",
    dest,
  ];
  const env = {
    ...process.env,
    PNPM_REPORTER: process.env.PNPM_REPORTER ?? "append-only",
  };

  if (process.platform === "win32") {
    console.log(
      "[prepare-server-agent] pnpm deploy on Windows often stays quiet for several minutes after \"Progress: … done\" while linking/copying files; 5–20 min is normal on CI.",
    );
  }

  const isWin = process.platform === "win32";
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", args, {
      cwd: repoRoot,
      stdio: "inherit",
      env,
      shell: isWin,
    });

    const heartbeat = setInterval(() => {
      console.log(
        `[prepare-server-agent] pnpm deploy still running… (${Math.round(DEPLOY_HEARTBEAT_MS / 1000)}s heartbeat)`,
      );
    }, DEPLOY_HEARTBEAT_MS);

    child.on("error", (err) => {
      clearInterval(heartbeat);
      reject(err);
    });
    child.on("close", (code) => {
      clearInterval(heartbeat);
      resolve(code ?? 0);
    });
  });
}

async function main() {
  console.log("[prepare-server-agent] repo:", repoRoot);
  console.log("[prepare-server-agent] deploy (hoisted node_modules) ->:", bundleDir);

  rmRf(bundleDir);

  const code = await runPnpmDeploy(bundleDir);
  if (code !== 0) process.exit(code);

  removeBrokenSymlinks(bundleDir);
  console.log("[prepare-server-agent] done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
