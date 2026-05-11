import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "./config.js";

export function resolveServerAgentPath(): string {
  const config = readConfig();

  // 1. Explicit config path
  if (config.serverAgentPath && existsSync(config.serverAgentPath)) {
    return config.serverAgentPath;
  }

  // 2. Adjacent directory (for bundled distributions)
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const adjacent = path.resolve(cliDir, "..", "..", "server-agent");
  const adjacentMain = path.join(adjacent, "dist", "main.js");
  if (existsSync(adjacentMain)) {
    return adjacent;
  }

  // 3. npm resolve
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve("@meshbot/server-agent/package.json");
    return path.dirname(pkgPath);
  } catch {
    throw new Error(
      "Could not find server-agent. Install with: npm install -g @meshbot/cli-agent",
    );
  }
}

export function getServerAgentMainPath(): string {
  const root = resolveServerAgentPath();
  return path.join(root, "dist", "main.js");
}
