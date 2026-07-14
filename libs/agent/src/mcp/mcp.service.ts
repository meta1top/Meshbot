import { existsSync, readFileSync } from "node:fs";
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { ToolRegistry } from "../tools/tool-registry";
import { buildMcpToolAdapter } from "./mcp-tool.adapter";
import {
  type McpConfig,
  type McpServerConfig,
  McpConfigSchema,
  isStdioServer,
} from "./mcp.schema";

/** 闲置回收阈值：30 分钟无活跃 run 且未被使用则关闭子进程。 */
const IDLE_RECLAIM_MS = 30 * 60_000;

/** 回收扫描间隔。 */
const SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * 单 Agent 的 MCP 运行态：client + 已注册工具名 + 活跃 run 引用计数 + 最近使用时刻。
 * client 为 null 表示「该 Agent 无 MCP 配置或加载失败」——仍登记，避免每次 run
 * 重复读盘重试。
 */
interface AgentMcp {
  client: MultiServerMCPClient | null;
  names: Set<string>;
  refCount: number;
  lastUsedAt: number;
}

/**
 * MCP 集成入口（v4 按「账号+Agent」懒加载）。生命周期：
 *
 * - 不再登录时一次性起账号全部 MCP —— 5 个 Agent × 3 个 stdio server 登录就要拉
 *   15 个子进程。改为 Agent 首次被使用（`ensureAgent`）时才懒加载，闲置
 *   `IDLE_RECLAIM_MS` 且无活跃 run（`refCount === 0`）时由后台定时扫描
 *   （`sweepIdle`）回收。
 * - `acquire` / `release` 由调用方（RunnerService）在 run 前后配对调用，
 *   `release` 必须在 `finally` 里——否则 run 抛错后引用计数永远漏，回收会
 *   被永久跳过。
 * - `onModuleDestroy`：拆掉所有 Agent 的 client，关子进程 / 长连接。
 */
@Injectable()
export class McpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpService.name);

  /** `${cloudUserId}:${agentId}` → 该 Agent 的 MCP 运行态。 */
  private readonly perAgent = new Map<string, AgentMcp>();

  /**
   * `ensureAgent` 按 key 缓存进行中的 promise（进程内 in-flight 去重）。
   * check-then-act（`perAgent.get` 读 → `createClient`/`getTools` 写）之间
   * 隔着真实 stdio MCP 握手的 await 边界（几百 ms 到几秒），同一 Agent 被
   * 两个会话（多标签页 / 主会话+子代理）并发首次使用时会各自读到「未就绪」
   * 并各建一个 client，需要复用同一个 in-flight promise 避免子进程泄漏
   * （与 `apps/server-agent/src/services/agent.service.ts` 的
   * `ensureDefault()` 同款模式）。
   */
  private readonly ensureAgentInFlight = new Map<string, Promise<void>>();

  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: MeshbotConfigService,
    private readonly registry: ToolRegistry,
  ) {}

  /**
   * 懒加载：确保该 Agent 的 MCP 已就绪。已就绪则只刷新 lastUsedAt。
   *
   * **契约：必须在 `accountContext.run(cloudUserId, () => agentContext.run(agentId, ...))`
   * 双层上下文内调用** —— loadConfig 读的是 Agent 化路径 `getMcpConfigPath()`，
   * 依赖两层 ALS。
   *
   * mcp.json 不存在 / 无 server / 加载失败时**也登记一个空运行态**，避免每次 run
   * 都重复读盘重试。配置改动后由 REST 层调 `teardownAgent` 使其失效。
   *
   * **并发去重**：check（`perAgent.get`）与 act（`createClient` + `getTools`）
   * 之间隔着真实 stdio MCP 握手的 await 边界，同一 Agent 被两个会话并发
   * 首次使用时，未就绪判断会同时命中——按 key 缓存 in-flight promise，
   * 并发调用复用同一个 promise，避免各自建 client 导致后者覆盖前者、
   * 前者从此在 `perAgent` 里不可见而永久泄漏子进程。
   *
   * @param cloudUserId 账号 ID（= JWT sub）
   * @param agentId Agent ID
   */
  async ensureAgent(cloudUserId: string, agentId: string): Promise<void> {
    const key = agentKey(cloudUserId, agentId);
    const existing = this.perAgent.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return;
    }
    const inFlight = this.ensureAgentInFlight.get(key);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.doEnsureAgent(cloudUserId, agentId).finally(() => {
      // 成功失败都要清，否则失败一次就把错误 promise 永久缓存住。
      this.ensureAgentInFlight.delete(key);
    });
    this.ensureAgentInFlight.set(key, promise);
    return promise;
  }

  /** ensureAgent 去重后的实际加载逻辑：读配置、建 client、注册工具。 */
  private async doEnsureAgent(
    cloudUserId: string,
    agentId: string,
  ): Promise<void> {
    const key = agentKey(cloudUserId, agentId);
    const cfg = this.loadConfig();
    if (!cfg || Object.keys(cfg.mcpServers).length === 0) {
      this.registerEmptyRuntime(key);
      return;
    }
    const mcpServers = mapServersToLangchainShape(cfg.mcpServers);
    let client: MultiServerMCPClient | undefined;
    try {
      client = this.createClient(mcpServers);
      const tools = (await client.getTools()) as StructuredToolInterface[];
      const names = new Set<string>();
      for (const lcTool of tools) {
        try {
          const { meshbot } = buildMcpToolAdapter(lcTool);
          this.registry.registerForAgent(cloudUserId, agentId, meshbot, lcTool);
          names.add(meshbot.name);
        } catch (err) {
          // 单颗 tool 适配 / 注册失败只跳过，不拖垮其他 server。
          this.logger.warn(
            `Skip MCP tool "${lcTool.name}" for ${key}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      this.perAgent.set(key, {
        client,
        names,
        refCount: 0,
        lastUsedAt: Date.now(),
      });
      this.logger.log(
        `MCP ready for ${key}: ${names.size} tools from ${Object.keys(mcpServers).length} server(s).`,
      );
    } catch (err) {
      // createClient 同步抛错时 client 仍是 undefined，无需 / 无法 close；
      // getTools 抛错时 client 已建出，best-effort 关掉，不留泄漏的子进程。
      this.logger.error(
        `Failed to load MCP tools for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (client) {
        try {
          await client.close();
        } catch {
          // best-effort 清理，已记主错。
        }
      }
      this.registerEmptyRuntime(key);
    }
  }

  /** 登记一个空运行态（无 MCP 配置 / 加载失败），避免重复读盘重试。 */
  private registerEmptyRuntime(key: string): void {
    this.perAgent.set(key, {
      client: null,
      names: new Set(),
      refCount: 0,
      lastUsedAt: Date.now(),
    });
  }

  /** 标记该 Agent 有活跃 run（回收保护）。 */
  acquire(cloudUserId: string, agentId: string): void {
    const entry = this.perAgent.get(agentKey(cloudUserId, agentId));
    if (entry) {
      entry.refCount += 1;
      entry.lastUsedAt = Date.now();
    }
  }

  /** 活跃 run 结束（解除回收保护）。 */
  release(cloudUserId: string, agentId: string): void {
    const entry = this.perAgent.get(agentKey(cloudUserId, agentId));
    if (entry) {
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastUsedAt = Date.now();
    }
  }

  /**
   * 回收闲置 Agent 的 MCP 子进程：refCount 为 0 且超过 IDLE_RECLAIM_MS 未使用。
   * now 显式传入便于测试；生产由定时器每 5 分钟调一次。
   *
   * refCount > 0 一律跳过——有 run 正在跑时回收会当场抽掉它的工具。
   */
  async sweepIdle(now: number): Promise<void> {
    for (const [key, entry] of [...this.perAgent.entries()]) {
      if (entry.refCount > 0) continue;
      if (now - entry.lastUsedAt < IDLE_RECLAIM_MS) continue;
      const { cloudUserId, agentId } = splitAgentKey(key);
      await this.teardownAgent(cloudUserId, agentId);
    }
  }

  /** 拆掉单个 Agent 的 MCP 运行态：反注册工具、关闭 client。幂等。 */
  async teardownAgent(cloudUserId: string, agentId: string): Promise<void> {
    const key = agentKey(cloudUserId, agentId);
    const entry = this.perAgent.get(key);
    if (!entry) {
      return;
    }
    this.perAgent.delete(key);
    this.registry.unregisterAgent(cloudUserId, agentId);
    if (!entry.client) {
      return;
    }
    try {
      await entry.client.close();
    } catch (err) {
      this.logger.warn(
        `MCP client close error for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 拆掉某账号下**全部 Agent** 的 MCP 运行态（登出时调用）。幂等。 */
  async teardownAccount(cloudUserId: string): Promise<void> {
    const prefix = `${cloudUserId}:`;
    for (const key of [...this.perAgent.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const { agentId } = splitAgentKey(key);
      await this.teardownAgent(cloudUserId, agentId);
    }
  }

  onModuleInit(): void {
    // .unref() 必须有：否则 Jest 会报「worker process failed to exit gracefully」。
    this.sweepTimer = setInterval(() => {
      void this.sweepIdle(Date.now());
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    for (const key of [...this.perAgent.keys()]) {
      const { cloudUserId, agentId } = splitAgentKey(key);
      await this.teardownAgent(cloudUserId, agentId);
    }
  }

  /**
   * 构造 MultiServerMCPClient。抽成可覆盖方法，便于测试用 stub 替换真 client。
   */
  protected createClient(
    mcpServers: Record<string, Record<string, unknown>>,
  ): MultiServerMCPClient {
    return new MultiServerMCPClient({
      // mcp-adapters 期望 union 类型；我们的 schema 已收敛到 stdio | http/sse 二选一，
      // 但 union narrowing 走运行期判别（isStdioServer），TS 不能从 record 整体推回。
      mcpServers: mcpServers as never,
      // 单 server 连不上不要拖垮整个 agent；写日志即可。
      onConnectionError: "ignore",
      throwOnLoadError: false,
      prefixToolNameWithServerName: true,
      additionalToolNamePrefix: "mcp",
      useStandardContentBlocks: true,
    });
  }

  /**
   * 读 & 校验当前 Agent 的 mcp.json（Agent 化路径）。文件不存在返 null；
   * JSON / schema 解析失败打日志返 null（配置写坏应被发现，但不拖垮启动）。
   */
  private loadConfig(): McpConfig | null {
    const path = this.config.getMcpConfigPath();
    if (!existsSync(path)) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      this.logger.error(
        `Invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    const parsed = McpConfigSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error(
        `mcp.json schema validation failed: ${parsed.error.message}`,
      );
      return null;
    }
    return parsed.data;
  }
}

/**
 * 「账号+Agent」复合键。**不变量**：cloudUserId 本身不含冒号（雪花数字 id /
 * JWT sub），splitAgentKey 才能安全地按首个冒号切分还原；unregisterAccount /
 * teardownAccount 的前缀匹配（`${cloudUserId}:`）也依赖这条不变量。
 */
function agentKey(cloudUserId: string, agentId: string): string {
  return `${cloudUserId}:${agentId}`;
}

/** 拆回 {cloudUserId, agentId}。两段 id 都不含冒号（雪花 / JWT sub），按首个冒号切分。 */
function splitAgentKey(key: string): { cloudUserId: string; agentId: string } {
  const idx = key.indexOf(":");
  return {
    cloudUserId: key.slice(0, idx),
    agentId: key.slice(idx + 1),
  };
}

/**
 * 把我们 mcp.json 的 server 配置转成 @langchain/mcp-adapters 期望的形状：
 * - stdio：补 `transport: "stdio"` + 默认空 args
 * - http/sse：补 `transport: "streamable_http"`（默认）或用户指定的 transport
 */
function mapServersToLangchainShape(
  servers: Record<string, McpServerConfig>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (isStdioServer(cfg)) {
      out[name] = {
        transport: "stdio",
        command: cfg.command,
        args: cfg.args ?? [],
        ...(cfg.env ? { env: cfg.env } : {}),
      };
    } else {
      out[name] = {
        transport: cfg.transport ?? "streamable_http",
        url: cfg.url,
        ...(cfg.headers ? { headers: cfg.headers } : {}),
      };
    }
  }
  return out;
}
