import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function findRepoRoot(startDir: string): string | null {
  let currentDir = startDir;

  while (true) {
    if (existsSync(path.join(currentDir, "pnpm-workspace.yaml"))) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function isPackaged(): boolean {
  return __dirname.includes(".app/Contents/Resources");
}

export function resolveMeshbotDir(): string {
  // 显式指定（desktop 主进程 fork 时会注入）优先级最高，跨平台无歧义
  if (process.env.MESHBOT_HOME) {
    return process.env.MESHBOT_HOME;
  }
  if (isPackaged()) {
    return path.join(homedir(), ".meshbot");
  }
  const repoRoot = findRepoRoot(process.cwd()) ?? findRepoRoot(__dirname);
  if (repoRoot) {
    return path.join(repoRoot, ".meshbot");
  }
  return path.join(homedir(), ".meshbot");
}
