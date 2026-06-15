import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import { AccountContextService } from "../account/account-context.service";

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

  constructor(private readonly account: AccountContextService) {
    this.meshbotDir = resolveMeshbotDir();
  }

  getMeshbotDir(): string {
    return this.meshbotDir;
  }

  /**
   * 当前账号专属数据根：<meshbotDir>/accounts/<cloudUserId>，自动 mkdir。
   * 无账号上下文时 getOrThrow 抛错——账号化文件 getter 必须在账号上下文内调用。
   */
  private accountDir(): string {
    const dir = path.join(
      this.meshbotDir,
      "accounts",
      this.account.getOrThrow(),
    );
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Prompt 目录：<meshbotDir>/accounts/<account>/prompt（按账号隔离）。 */
  getPromptDir(): string {
    return path.join(this.accountDir(), "prompt");
  }

  /**
   * Skills 根目录：<meshbotDir>/accounts/<account>/skills（按账号隔离）；
   * 每个子目录一个 skill，含 SKILL.md。
   */
  getSkillsDir(): string {
    return path.join(this.accountDir(), "skills");
  }

  /**
   * MCP 配置：<meshbotDir>/accounts/<account>/mcp.json（按账号隔离）；
   * 不存在视作无 MCP server。
   */
  getMcpConfigPath(): string {
    return path.join(this.accountDir(), "mcp.json");
  }

  /**
   * 本地 SQLite 数据库路径：<meshbotDir>/agent.db。
   * 固定共享——所有账号同库（行级 cloudUserId 隔离），不随账号变；
   * 模块初始化期（无账号上下文）也会被调用，故不能账号化。
   */
  getDatabasePath(): string {
    return path.join(this.meshbotDir, "agent.db");
  }

  /**
   * Bash tool 默认 cwd —— 按账号隔离 <meshbotDir>/accounts/<account>/workspace，自动 mkdir。
   * - prod：~/.meshbot/accounts/<account>/workspace
   * - dev：<repoRoot>/.meshbot/accounts/<account>/workspace
   * 可被环境变量 MESHBOT_WORKSPACE 覆盖（覆盖时不依赖账号上下文）。
   */
  getWorkspaceDir(): string {
    if (process.env.MESHBOT_WORKSPACE) {
      return process.env.MESHBOT_WORKSPACE;
    }
    const dir = path.join(this.accountDir(), "workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
