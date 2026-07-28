import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { AccountContextService } from "../account/account-context.service";
import { AgentContextService } from "../account/agent-context.service";
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
 * 已被 `teardownAgent` 移出 `perAgent`、但仍有活跃 run 持有引用
 * （`refCount > 0`）的运行态：client 关闭延迟到 `release()` 把它降到 0——
 * 见 `retired` 字段的并发不变量说明。
 */
interface RetiredAgentMcp {
  entry: AgentMcp;
  /** 挂起时刻，供 `sweepIdle` 的安全网判断「卡住太久」。 */
  retiredAt: number;
}

/**
 * `acquire()` 返回给调用方的不透明身份句柄，`release()` 时原样传回做**精确
 * 身份匹配**（而不是按 `(cloudUserId, agentId)` 键去 `perAgent`/`retired`
 * 里"猜"该扣哪个 entry）。对外只是 `object`——调用方（`RunnerService`）只需
 * 原样保存、在 `finally` 里传回，不应假设/依赖其内部结构；内部实现上它就是
 * 那次 acquire 命中的 `AgentMcp` 引用本身，`release` 用 `===` 比对定位。
 */
export type AgentMcpHandle = object;

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
 *
 * **热重载并发不变量**（`reloadAgent` / `updateConfig` 尾调）：`teardownAgent`
 * 若发现当前 entry `refCount > 0`（有 run 正在用），**不会立即 close
 * client**——那会打断正在执行中的 MCP 工具调用。而是把 entry 移入
 * `retired`（挂起列表），`perAgent` 上同 key 立刻换成新建的 entry（新工具
 * 立即可见，热生效不受影响）。
 *
 * **身份精确匹配**（不是按 key 猜测）：`acquire()` 返回一个不透明的
 * `AgentMcpHandle`（本质是那次 acquire 命中的 entry 引用），调用方必须原样
 * 保存并在 `release()` 时传回。`release` 用 `===` 精确定位该 handle 对应
 * 的 entry——是当前 `perAgent` 里的那个就直接递减；是 `retired` 挂起里的
 * 那个就在挂起列表里递减，归零才 `close`；两处都找不到（entry 已关闭 /
 * 传入了不认识的 handle）则 no-op + warn，绝不误伤任何在用状态。这保证了
 * 即使多个并发 run 共享同一个 entry、且中途发生了 reload（旧 entry 被挂起、
 * 新 entry 顶替同一个 key），每次 release 也只会精确命中调用方自己那次
 * acquire 拿到的那个 entry——不会出现「新 run 的 release 误砍了旧 entry
 * 的配额，导致旧 entry 在其真正的持有者还没结束时就被提前 close」这类
 * 按 key 猜测必然存在的错配风险（早期版本按 key 猜测的 FIFO 启发式已被
 * 淘汰，见本文件历史/测试里 "run A/D 共享 entry1、run C 交错 release"
 * 场景的专门用例）。
 *
 * `retired` 列表本身依然保留——不是给身份匹配兜底，而是给**极端异常路径**
 * 兜底（例如 handle 因调用方 bug 丢失、或 release 从未被调用）：`sweepIdle`
 * 的安全网仍按 `retiredAt` 超过闲置阈值强制关闭，避免这种情况下的永久泄漏。
 */
@Injectable()
export class McpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpService.name);

  /** `${cloudUserId}:${agentId}` → 该 Agent 的 MCP 运行态。 */
  private readonly perAgent = new Map<string, AgentMcp>();

  /**
   * `${cloudUserId}:${agentId}` → 该 key 下挂起等待 refCount 归零才关闭的
   * 旧运行态列表（通常 0~1 条；理论上可能因短时间内多次 reload 而堆叠多条，
   * 用数组按挂起顺序保留全部）。
   */
  private readonly retired = new Map<string, RetiredAgentMcp[]>();

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
    private readonly account: AccountContextService,
    private readonly agentCtx: AgentContextService,
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

  /**
   * 标记该 Agent 有活跃 run（回收保护），返回一个身份句柄——调用方须原样
   * 保存并在 `release()` 时传回（详见 `AgentMcpHandle` 类型注释）。该 Agent
   * 尚无运行态（`ensureAgent` 未调用过 / 已被拆掉）时返回 `null`。
   */
  acquire(cloudUserId: string, agentId: string): AgentMcpHandle | null {
    const entry = this.perAgent.get(agentKey(cloudUserId, agentId));
    if (!entry) {
      return null;
    }
    entry.refCount += 1;
    entry.lastUsedAt = Date.now();
    return entry;
  }

  /**
   * 活跃 run 结束（解除回收保护）。**按身份精确匹配**：`handle` 是调用方在
   * 对应 `acquire()` 拿到的引用，这里先看它是不是 `perAgent` 里的当前
   * entry（正常路径，直接递减）；不是则去 `retired` 挂起列表里按 `===`
   * 找到它（reload 把它挂起的情形），归零才 `close` 并移出列表。两处都找
   * 不到——entry 已经关闭，或者传入了一个不认识的 handle——no-op + warn，
   * **绝不**退化为「猜一个 entry 硬扣」（早期版本按 `(cloudUserId,
   * agentId)` key 猜测最老挂起条目的 FIFO 启发式已被淘汰：多个并发 run
   * 共享同一 entry、且其中一个 run 触发 reload 时，无关的第三个 run 提前
   * release 会把 FIFO 猜测命中同一个挂起 entry，导致它在真正的持有者还没
   * 结束前就被提前 close——见 `mcp.service.spec.ts` 里 "run A/D 共享 entry1、
   * run C 交错 release" 的专门用例）。`handle` 为 `null`（对应 `acquire()`
   * 当时就没拿到 entry）时安静 no-op，语义等同"本来就没什么可释放的"。
   */
  release(
    cloudUserId: string,
    agentId: string,
    handle: AgentMcpHandle | null,
  ): void {
    if (!handle) {
      return;
    }
    const key = agentKey(cloudUserId, agentId);
    const entry = handle as AgentMcp;

    const current = this.perAgent.get(key);
    if (current === entry) {
      entry.refCount = Math.max(0, entry.refCount - 1);
      entry.lastUsedAt = Date.now();
      return;
    }

    const retiredList = this.retired.get(key);
    const idx = retiredList?.findIndex((r) => r.entry === entry) ?? -1;
    if (retiredList && idx >= 0) {
      const retiredItem = retiredList[idx];
      retiredItem.entry.refCount = Math.max(0, retiredItem.entry.refCount - 1);
      if (retiredItem.entry.refCount === 0) {
        retiredList.splice(idx, 1);
        if (retiredList.length === 0) {
          this.retired.delete(key);
        }
        void this.closeEntryClient(key, retiredItem.entry);
      }
      return;
    }

    // 身份不匹配：entry 既不是当前运行态、也不在挂起列表里——正常生命周期
    // 里 entry 只会经历 current → retired → closed 三态，closed 后不该再
    // 被 release。理论上不该发生（stale handle / 重复 release 之类调用方
    // bug），防御性 no-op，不猜测、不误伤任何在用状态，只记警告便于定位。
    this.logger.warn(
      `release() identity mismatch for ${key}: handle's entry is neither the current nor a retired runtime (already closed, or a stale/duplicate handle) — ignored, no refCount mutated.`,
    );
  }

  /**
   * 回收闲置 Agent 的 MCP 子进程：refCount 为 0 且超过 IDLE_RECLAIM_MS 未使用。
   * now 显式传入便于测试；生产由定时器每 5 分钟调一次。
   *
   * refCount > 0 一律跳过——有 run 正在跑时回收会当场抽掉它的工具。
   *
   * 安全网：正常情况下 `retired` 条目会在对应 run 的 `release()`（`finally`
   * 里必调，且现在按身份精确匹配）归零后自然清空；这里仍保留按 `retiredAt`
   * 超过闲置阈值强制关闭的兜底——照顾调用方 bug 弄丢 handle、或 release
   * 从未被调用等异常路径，避免子进程 / 长连接永久泄漏。
   */
  async sweepIdle(now: number): Promise<void> {
    for (const [key, entry] of [...this.perAgent.entries()]) {
      if (entry.refCount > 0) continue;
      if (now - entry.lastUsedAt < IDLE_RECLAIM_MS) continue;
      const { cloudUserId, agentId } = splitAgentKey(key);
      await this.teardownAgent(cloudUserId, agentId);
    }
    for (const [key, list] of [...this.retired.entries()]) {
      const stale = list.filter((r) => now - r.retiredAt >= IDLE_RECLAIM_MS);
      if (stale.length === 0) continue;
      for (const r of stale) {
        this.logger.warn(
          `Retired MCP entry for ${key} stuck with refCount=${r.entry.refCount} past idle threshold; force closing (possible release() leak).`,
        );
        await this.closeEntryClient(key, r.entry);
      }
      const remaining = list.filter((r) => now - r.retiredAt < IDLE_RECLAIM_MS);
      if (remaining.length > 0) {
        this.retired.set(key, remaining);
      } else {
        this.retired.delete(key);
      }
    }
  }

  /**
   * 拆掉单个 Agent 的 MCP 运行态：反注册工具、关闭 client。幂等。
   *
   * **refCount > 0 时不会立即关闭 client**——有 run 正在用（典型场景：
   * `reloadAgent` 由该 run 自己触发的 MCP 写工具调用引起），当场关闭会打断
   * 它正在执行中的工具调用。此时把 entry 移入 `retired` 挂起，delay close
   * 到 `release()` 把它的引用计数降到 0（见 `release` 的身份路由注释）。
   */
  async teardownAgent(cloudUserId: string, agentId: string): Promise<void> {
    const key = agentKey(cloudUserId, agentId);
    const entry = this.perAgent.get(key);
    if (!entry) {
      return;
    }
    this.perAgent.delete(key);
    this.registry.unregisterAgent(cloudUserId, agentId);
    if (entry.refCount > 0) {
      const list = this.retired.get(key) ?? [];
      list.push({ entry, retiredAt: Date.now() });
      this.retired.set(key, list);
      this.logger.log(
        `MCP entry for ${key} retired with refCount=${entry.refCount}; client close deferred until drained.`,
      );
      return;
    }
    await this.closeEntryClient(key, entry);
  }

  /** best-effort 关闭 entry 的 client（`client:null` 安全 no-op）。 */
  private async closeEntryClient(key: string, entry: AgentMcp): Promise<void> {
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

  /**
   * 进程退出：拆全部 Agent 运行态。`teardownAgent` 对 refCount>0 的 entry
   * 只会挂 retired、不关闭——但进程都要退出了，没有"等 release 归零"的
   * 意义，因此这里额外强制关闭全部挂起条目（忽略其 refCount）。
   */
  async onModuleDestroy(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
    }
    for (const key of [...this.perAgent.keys()]) {
      const { cloudUserId, agentId } = splitAgentKey(key);
      await this.teardownAgent(cloudUserId, agentId);
    }
    for (const [key, list] of [...this.retired.entries()]) {
      for (const r of list) {
        await this.closeEntryClient(key, r.entry);
      }
    }
    this.retired.clear();
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
   *
   * 公开给 ContextBuilder（组装 system:mcp 清单）与自管理工具（mcp_list 等）
   * 读取配置态；须在账号+Agent ALS 内调用（同 ensureAgent 的契约）。
   */
  loadConfig(): McpConfig | null {
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

  /**
   * 读-改-写 mcp.json（单一写入真相：REST PUT 与自管理工具共用）。
   * mutator 拿到当前配置（无文件时为空配置）返回新配置；校验失败抛错不落盘；
   * 成功落盘后立即 `reloadAgent`（teardown + 重建）——**本轮对话内热生效**：
   * supervisor 每步现算工具集（`graph.builder` 的 toolsProvider），下一个
   * supervisor 步就能看到新工具，不必等到下一轮对话。须在账号+Agent ALS
   * 内调用。
   */
  async updateConfig(mutator: (config: McpConfig) => McpConfig): Promise<void> {
    const current = this.loadConfig() ?? { mcpServers: {} };
    const next = McpConfigSchema.parse(mutator(structuredClone(current)));
    const path = this.config.getMcpConfigPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await this.reloadAgent(
      this.account.getOrThrow(),
      this.agentCtx.getOrThrow(),
    );
  }

  /**
   * teardown + 立即 `ensureAgent` 重建运行态，供 `updateConfig` 尾调。
   *
   * **降级语义**：`ensureAgent`/`doEnsureAgent` 自身已把「新配置连不上」
   * 兜底为空运行态（`onConnectionError:"ignore"` + `registerEmptyRuntime`），
   * 从不向外抛错——因此这里不需要额外 try/catch：配置本身合法就应该落盘
   * 成功，重建连不上只是运行态退化为空，不应该让 `updateConfig` 抛错回滚
   * 已经写盘的合法配置。
   */
  private async reloadAgent(
    cloudUserId: string,
    agentId: string,
  ): Promise<void> {
    await this.teardownAgent(cloudUserId, agentId);
    await this.ensureAgent(cloudUserId, agentId);
  }

  /** 该 Agent 本轮运行态已加载的 MCP 工具名（null = 尚无运行态/未加载）。 */
  getLoadedToolNames(
    cloudUserId: string,
    agentId: string,
  ): ReadonlySet<string> | null {
    return this.perAgent.get(agentKey(cloudUserId, agentId))?.names ?? null;
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
 * - `enabled === false` 的 server 直接跳过，不建连接（配置本身仍保留在
 *   mcp.json 里——清单注入 / 自管理工具仍能看到禁用项，只是不会被加载）
 * - stdio：补 `transport: "stdio"` + 默认空 args
 * - http/sse：补 `transport: "streamable_http"`（默认）或用户指定的 transport
 *
 * 导出供测试直接单测过滤逻辑，无需起真实/桩 client。
 */
export function mapServersToLangchainShape(
  servers: Record<string, McpServerConfig>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (cfg.enabled === false) continue;
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
