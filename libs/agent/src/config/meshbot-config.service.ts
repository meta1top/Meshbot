import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Injectable } from "@nestjs/common";

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
  try {
    return __dirname.includes(".app/Contents/Resources");
  } catch {
    return false;
  }
}

function resolveMeshbotDir(): string {
  if (isPackaged()) {
    return path.join(homedir(), ".meshbot");
  }
  const repoRoot = findRepoRoot(process.cwd()) ?? findRepoRoot(__dirname);
  if (repoRoot) {
    return path.join(repoRoot, ".meshbot");
  }
  return path.join(homedir(), ".meshbot");
}

@Injectable()
export class MeshbotConfigService {
  private readonly meshbotDir: string;

  constructor() {
    this.meshbotDir = resolveMeshbotDir();
  }

  getMeshbotDir(): string {
    return this.meshbotDir;
  }

  getPromptDir(): string {
    return path.join(this.meshbotDir, "prompt");
  }

  getDatabasePath(): string {
    return path.join(this.meshbotDir, "agent.db");
  }

  /**
   * Bash tool 默认 cwd。
   * - prod：~/.meshbot/workspace/（不存在则 mkdir）
   * - dev/test（meshbotDir 在 repo 根下）：repo 根
   * - 可被环境变量 MESHBOT_WORKSPACE 覆盖
   */
  getWorkspaceDir(): string {
    if (process.env.MESHBOT_WORKSPACE) {
      return process.env.MESHBOT_WORKSPACE;
    }
    const home = homedir();
    if (this.meshbotDir.startsWith(home)) {
      const dir = path.join(this.meshbotDir, "workspace");
      mkdirSync(dir, { recursive: true });
      return dir;
    }
    // dev：meshbotDir = <repoRoot>/.meshbot，repo 根就是它的 parent
    return path.dirname(this.meshbotDir);
  }
}
