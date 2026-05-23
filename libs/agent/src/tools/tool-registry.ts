import { Injectable, OnModuleInit } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import { tool as createLcTool } from "@langchain/core/tools";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { TOOL_METADATA_KEY } from "./tool.decorator";
import type { MeshbotTool } from "./tool.types";

/**
 * 启动时扫描所有 @Tool() provider 自注册；singleton；重名 fail-fast。
 *
 * asLangChainBindable() 返回的 LC tool 实例**不会**被 LangChain 真调（我们
 * 自写 toolsNode），仅用于 model.bindTools() 把 schema 注入 LLM。真正的
 * 执行在 toolsNode 里用 registry.get(name).execute(args, ctx)。
 */
@Injectable()
export class ToolRegistry implements OnModuleInit {
  private readonly tools = new Map<string, MeshbotTool>();

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
      if (this.tools.has(tool.name)) {
        throw new Error(`Duplicate tool name: ${tool.name}`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  /** LC tool 数组用于 model.bindTools()。func 是占位，不会被真调。 */
  asLangChainBindable(): StructuredToolInterface[] {
    return [...this.tools.values()].map((t) =>
      createLcTool(async () => "", {
        name: t.name,
        description: t.description,
        schema: t.schema,
      }),
    );
  }

  get(name: string): MeshbotTool | undefined {
    return this.tools.get(name);
  }

  list(): MeshbotTool[] {
    return [...this.tools.values()];
  }
}
