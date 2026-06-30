import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROD_CLOUD_URL = "https://api.meshbot.app";
const DEV_CLOUD_URL = "http://127.0.0.1:3200";

/** 向上查找 pnpm-workspace.yaml，判断是否在 monorepo 源码内运行（= 开发）。 */
function inMonorepoSource(startDir: string): boolean {
  let dir = startDir;
  while (true) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * 决定 CLI 注入给 server-agent 的 MESHBOT_CLOUD_URL：
 * - 显式 env 最高优先级（自托管 / staging）；
 * - monorepo 源码运行（pnpm dev:cli-agent）→ 本地 3200；
 * - 分发安装版 → 生产 api.meshbot.app。
 */
export function resolveCloudUrl(opts?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): string {
  const env = opts?.env ?? process.env;
  if (env.MESHBOT_CLOUD_URL) return env.MESHBOT_CLOUD_URL;
  const cwd = opts?.cwd ?? path.dirname(fileURLToPath(import.meta.url));
  return inMonorepoSource(cwd) ? DEV_CLOUD_URL : PROD_CLOUD_URL;
}
