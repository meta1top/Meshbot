import { tool as createLcTool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Injectable, OnModuleInit, Optional } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import { AccountContextService } from "../account/account-context.service";
import { AgentContextService } from "../account/agent-context.service";
import { TOOL_METADATA_KEY } from "./tool.decorator";
import { ToolPrefsService } from "./tool-prefs.service";
import type { MeshbotTool } from "./tool.types";

/** 无禁用工具时复用的空集，避免每次消费口都新建一个 Set。 */
const EMPTY_DISABLED: ReadonlySet<string> = new Set();

/** 注册项：执行用 meshbotTool，bindTools 用 lcTool。两者一一对应。 */
interface Entry {
  meshbotTool: MeshbotTool;
  lcTool: StructuredToolInterface;
}

/**
 * 启动时扫描所有 @Tool() provider 自注册；singleton；重名 fail-fast。
 *
 * 静态 @Tool() 的 lcTool 由 MeshbotTool meta 现造；MCP 等动态 tool 走
 * `register(tool, lcTool)` 自带 lcTool，保留 server 端原始 schema 给 LLM。
 *
 * asLangChainBindable() 返回的 LC tool 实例**不会**被 LangChain 真调（我们
 * 自写 toolsNode），仅用于 model.bindTools() 把 schema 注入 LLM。真正的
 * 执行在 toolsNode 里用 registry.get(name).execute(args, ctx)。
 *
 * 内置工具（@Tool() / register 扫出来的 bash/read/write/grep 等）写入全局
 * entries，对所有账号、所有 Agent 都可见；MCP 工具写入 agentEntries（按
 * 「账号+Agent」复合键分桶），解析时与当前 ALS 的账号 + Agent 上下文合并——
 * 同账号下不同 Agent 的 MCP 工具彼此不可见。
 */
@Injectable()
export class ToolRegistry implements OnModuleInit {
  private readonly entries = new Map<string, Entry>();

  /** MCP 工具按「账号+Agent」键：`${cloudUserId}:${agentId}` → (toolName → Entry) */
  private readonly agentEntries = new Map<string, Map<string, Entry>>();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly account: AccountContextService,
    private readonly agent: AgentContextService,
    @Optional() private readonly toolPrefs?: ToolPrefsService,
  ) {}

  onModuleInit(): void {
    const providers = this.discovery.getProviders();
    for (const wrapper of providers) {
      const instance = wrapper.instance;
      if (!instance || typeof instance !== "object") continue;
      const ctor = (instance as object).constructor;
      if (!ctor) continue;
      const isTool = Reflect.getMetadata(TOOL_METADATA_KEY, ctor);
      if (!isTool) continue;
      const tool = instance as MeshbotTool;
      this.registerInternal(tool, buildLcTool(tool));
    }
  }

  /**
   * 动态注册一个 tool（MCP / 插件等运行期来源）。重名抛错。
   * @param tool MeshbotTool 实现（提供 execute + 元信息）
   * @param lcTool 可选：用作 bindTools 的 LC tool。不传则按 MeshbotTool meta 现造。
   *   MCP tool 传入 server 端的原始 LC tool，确保 LLM 看到完整 schema。
   */
  register(tool: MeshbotTool, lcTool?: StructuredToolInterface): void {
    this.registerInternal(tool, lcTool ?? buildLcTool(tool));
  }

  /** 反注册（用于 MCP 断开重连 / shutdown 清理）。 */
  unregister(name: string): void {
    this.entries.delete(name);
  }

  /**
   * 为指定 Agent 注册一个 MCP 工具。同 Agent 重名时覆盖（upsert）。
   * @param cloudUserId 账号 ID（= JWT sub）
   * @param agentId Agent ID
   * @param tool MeshbotTool 实现
   * @param lcTool 用于 model.bindTools() 的 LC tool（保留 MCP server 原始 schema）
   */
  registerForAgent(
    cloudUserId: string,
    agentId: string,
    tool: MeshbotTool,
    lcTool: StructuredToolInterface,
  ): void {
    const key = agentKey(cloudUserId, agentId);
    let bucket = this.agentEntries.get(key);
    if (!bucket) {
      bucket = new Map();
      this.agentEntries.set(key, bucket);
    }
    bucket.set(tool.name, { meshbotTool: tool, lcTool });
  }

  /** 清除指定 Agent 的所有 MCP 工具（MCP 闲置回收 / 配置变更时调用）。 */
  unregisterAgent(cloudUserId: string, agentId: string): void {
    this.agentEntries.delete(agentKey(cloudUserId, agentId));
  }

  /** 清除指定账号下**全部 Agent** 的 MCP 工具（账号登出时调用）。 */
  unregisterAccount(cloudUserId: string): void {
    const prefix = `${cloudUserId}:`;
    for (const key of [...this.agentEntries.keys()]) {
      if (key.startsWith(prefix)) {
        this.agentEntries.delete(key);
      }
    }
  }

  private registerInternal(
    tool: MeshbotTool,
    lcTool: StructuredToolInterface,
  ): void {
    if (this.entries.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    this.entries.set(tool.name, { meshbotTool: tool, lcTool });
  }

  /**
   * 返回当前 ALS「账号 + Agent」上下文对应的 MCP 工具 map。
   * 缺任一上下文时返回空 Map，不抛错（内置工具仍可用）。
   */
  private currentAgentEntries(): Map<string, Entry> {
    const acct = this.account.get();
    const agentId = this.agent.get();
    if (!acct || !agentId) return new Map();
    return this.agentEntries.get(agentKey(acct, agentId)) ?? new Map();
  }

  /**
   * 当前 ALS Agent 的禁用工具集合（per-agent 工具启停，Agent 编辑器 v2 第二段）。
   * 只作用于全局内置 entries，MCP 桶（agentEntries）不受影响——MCP 工具已有
   * server 级启停，不需要在这里重复过滤。
   *
   * 无 ToolPrefsService（未接线，如旧测试直接 `new ToolRegistry(...)` 不传第四参）
   * 或无 Agent ALS（`getDisabledTools()` 经 `MeshbotConfigService.getToolsConfigPath()`
   * → `AgentContextService.getOrThrow()` 抛错）时一律不过滤，返回空集——
   * 与 `currentAgentEntries()` 同款「缺上下文不抛错」处理。
   */
  private disabledToolNames(): ReadonlySet<string> {
    if (!this.toolPrefs) return EMPTY_DISABLED;
    try {
      return this.toolPrefs.getDisabledTools();
    } catch {
      return EMPTY_DISABLED;
    }
  }

  /** 过滤掉被禁用的全局内置 entries；MCP 桶不参与本过滤。 */
  private enabledBuiltinEntries(): Entry[] {
    const disabled = this.disabledToolNames();
    if (disabled.size === 0) return [...this.entries.values()];
    return [...this.entries.values()].filter(
      (e) => !disabled.has(e.meshbotTool.name),
    );
  }

  /** LC tool 数组用于 model.bindTools()。内置（按当前 Agent 禁用集过滤）+ 当前账号+Agent MCP 工具合并。 */
  asLangChainBindable(): StructuredToolInterface[] {
    return [
      ...this.enabledBuiltinEntries(),
      ...this.currentAgentEntries().values(),
    ].map((e) => e.lcTool);
  }

  /** 命中禁用的内置工具与「未注册」同表现，返回 undefined；不影响同名 MCP 工具（MCP 桶不过滤）。 */
  get(name: string): MeshbotTool | undefined {
    const disabled = this.disabledToolNames();
    const builtin = disabled.has(name)
      ? undefined
      : this.entries.get(name)?.meshbotTool;
    return builtin ?? this.currentAgentEntries().get(name)?.meshbotTool;
  }

  list(): MeshbotTool[] {
    return [
      ...this.enabledBuiltinEntries(),
      ...this.currentAgentEntries().values(),
    ].map((e) => e.meshbotTool);
  }

  /**
   * 全量内置工具清单，**不受禁用过滤影响**——REST `GET /api/agents/:id/tools`
   * 需要展示含被禁用项在内的全量列表（供 UI 渲染开关态）。只读口，不含 MCP 工具
   * （MCP 已有独立的 server 级启停 REST）。
   */
  listBuiltinsUnfiltered(): MeshbotTool[] {
    return [...this.entries.values()].map((e) => e.meshbotTool);
  }
}

/** 「账号+Agent」复合键。 */
function agentKey(cloudUserId: string, agentId: string): string {
  return `${cloudUserId}:${agentId}`;
}

/** 用 MeshbotTool meta 构造一个占位 LC tool（func 不会被真调，仅供 bindTools）。 */
function buildLcTool(t: MeshbotTool): StructuredToolInterface {
  return createLcTool(async () => "", {
    name: t.name,
    description: t.description,
    schema: t.schema,
  });
}
