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
  // 显式指定（desktop 主进程 fork 每账号进程时注入）优先级最高，
  // 与 apps/server-agent/src/utils/meshbot-dir.ts 保持一致——确保设了
  // MESHBOT_HOME 后整棵本地数据树（db/mcp/skills/prompt/workspace）一起跟随。
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

  /** Skills 根目录：<meshbotDir>/skills；每个子目录一个 skill，含 SKILL.md。 */
  getSkillsDir(): string {
    return path.join(this.meshbotDir, "skills");
  }

  /** MCP 配置：<meshbotDir>/mcp.json；不存在视作无 MCP server。 */
  getMcpConfigPath(): string {
    return path.join(this.meshbotDir, "mcp.json");
  }

  getDatabasePath(): string {
    return path.join(this.meshbotDir, "agent.db");
  }

  /**
   * Bash tool 默认 cwd —— 一律 meshbotDir/workspace，自动 mkdir。
   * - prod：~/.meshbot/workspace
   * - dev：<repoRoot>/.meshbot/workspace
   * 可被环境变量 MESHBOT_WORKSPACE 覆盖。
   */
  getWorkspaceDir(): string {
    if (process.env.MESHBOT_WORKSPACE) {
      return process.env.MESHBOT_WORKSPACE;
    }
    const dir = path.join(this.meshbotDir, "workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
