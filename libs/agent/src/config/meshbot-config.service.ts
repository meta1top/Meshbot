import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import { AccountContextService } from "../account/account-context.service";
import { AgentContextService } from "../account/agent-context.service";

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

  constructor(
    private readonly account: AccountContextService,
    private readonly agent: AgentContextService,
  ) {
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
   * 当前 Agent 专属数据根：<meshbotDir>/accounts/<cloudUserId>/agents/<agentId>，自动 mkdir。
   * 无 Agent 上下文时 getOrThrow 抛错——Agent 化文件 getter 必须在 Agent 上下文内调用。
   */
  private agentDir(): string {
    const dir = path.join(this.accountDir(), "agents", this.agent.getOrThrow());
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Skills 根目录：<accountDir>/agents/<agentId>/skills（按 Agent 隔离）。 */
  getSkillsDir(): string {
    return path.join(this.agentDir(), "skills");
  }

  /**
   * 指定 Agent 的数据根（显式传 id，不走 ALS）：<accountDir>/agents/<agentId>。
   * 供「删除 Agent」这类需要操作**非当前** Agent 目录的场景使用——不像 `agentDir()`
   * 那样从 `AgentContextService` 读当前 Agent，也不 mkdir（删除前不该凭空建目录）。
   */
  agentDirOf(agentId: string): string {
    return path.join(this.accountDir(), "agents", agentId);
  }

  /** MCP 配置：<accountDir>/agents/<agentId>/mcp.json（按 Agent 隔离）。 */
  getMcpConfigPath(): string {
    return path.join(this.agentDir(), "mcp.json");
  }

  /**
   * 本地 SQLite 数据库路径（根库）：<meshbotDir>/main.db。
   * 固定共享——所有账号同库（行级 cloudUserId 隔离），不随账号变；
   * 模块初始化期（无账号上下文）也会被调用，故不能账号化。
   */
  getDatabasePath(): string {
    return path.join(this.meshbotDir, "main.db");
  }

  /**
   * 当前账号的 LangGraph checkpoint 库：<meshbotDir>/accounts/<account>/agent.db。
   * 与 TypeORM 根库（main.db）物理分离，避免 SqliteSaver 与 TypeORM 争锁；按账号隔离。
   * 必须在账号上下文内调用（accountDir 用 getOrThrow）。
   */
  getAccountCheckpointDbPath(): string {
    return path.join(this.accountDir(), "agent.db");
  }

  /** 记忆目录：<accountDir>/agents/<agentId>/memory（按 Agent 隔离）。 */
  getMemoryDir(): string {
    return path.join(this.agentDir(), "memory");
  }

  /**
   * Bash tool 默认 cwd —— 按 Agent 隔离 <meshbotDir>/accounts/<account>/agents/<agentId>/workspace，自动 mkdir。
   * - prod：~/.meshbot/accounts/<account>/agents/<agentId>/workspace
   * - dev：<repoRoot>/.meshbot/accounts/<account>/agents/<agentId>/workspace
   * 可被环境变量 MESHBOT_WORKSPACE 覆盖（覆盖时不依赖账号/Agent 上下文）。
   */
  getWorkspaceDir(): string {
    if (process.env.MESHBOT_WORKSPACE) {
      return process.env.MESHBOT_WORKSPACE;
    }
    const dir = path.join(this.agentDir(), "workspace");
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}
