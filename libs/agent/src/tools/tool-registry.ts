import { tool as createLcTool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
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
 */
@Injectable()
export class ToolRegistry implements OnModuleInit {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly discovery: DiscoveryService) {}

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

  private registerInternal(
    tool: MeshbotTool,
    lcTool: StructuredToolInterface,
  ): void {
    if (this.entries.has(tool.name)) {
      throw new Error(`Duplicate tool name: ${tool.name}`);
    }
    this.entries.set(tool.name, { meshbotTool: tool, lcTool });
  }

  /** LC tool 数组用于 model.bindTools()。MCP 工具走 server 原始 schema。 */
  asLangChainBindable(): StructuredToolInterface[] {
    return [...this.entries.values()].map((e) => e.lcTool);
  }

  get(name: string): MeshbotTool | undefined {
    return this.entries.get(name)?.meshbotTool;
  }

  list(): MeshbotTool[] {
    return [...this.entries.values()].map((e) => e.meshbotTool);
  }
}

/** 用 MeshbotTool meta 构造一个占位 LC tool（func 不会被真调，仅供 bindTools）。 */
function buildLcTool(t: MeshbotTool): StructuredToolInterface {
  return createLcTool(async () => "", {
    name: t.name,
    description: t.description,
    schema: t.schema,
  });
}
