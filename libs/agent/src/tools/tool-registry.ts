import { tool as createLcTool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import { AccountContextService } from "../account/account-context.service";
import { AgentContextService } from "../account/agent-context.service";
import { TOOL_METADATA_KEY } from "./tool.decorator";
import type { MeshbotTool } from "./tool.types";

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

  /** LC tool 数组用于 model.bindTools()。内置 + 当前账号+Agent MCP 工具合并。 */
  asLangChainBindable(): StructuredToolInterface[] {
    return [
      ...this.entries.values(),
      ...this.currentAgentEntries().values(),
    ].map((e) => e.lcTool);
  }

  get(name: string): MeshbotTool | undefined {
    return (
      this.entries.get(name)?.meshbotTool ??
      this.currentAgentEntries().get(name)?.meshbotTool
    );
  }

  list(): MeshbotTool[] {
    return [
      ...this.entries.values(),
      ...this.currentAgentEntries().values(),
    ].map((e) => e.meshbotTool);
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
