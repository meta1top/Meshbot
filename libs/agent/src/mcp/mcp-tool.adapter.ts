import type { StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import type { MeshbotTool, ToolContext } from "../tools/tool.types";

/**
 * 把 LangChain `StructuredTool`（来自 MCP）包成 MeshbotTool：
 * - `name` / `description` 透传
 * - schema 用 `z.any()` 占位：tools.node 那一层不再二次校验，由 lcTool.invoke
 *   自己校验（MCP 的原始 JSON Schema 已被 mcp-adapters 转成 Zod 注入 lcTool）
 * - execute 调 lcTool.invoke()，把 ctx.signal 透传，用户 Stop 可中断
 *
 * 注册到 ToolRegistry 时必须把原 lcTool 一起传过去（`registry.register(meshbot, lcTool)`），
 * 保证 bindTools() 给 LLM 的是 MCP 原始 schema，不是这里的 `z.any()`。
 */
export function buildMcpToolAdapter(lcTool: StructuredToolInterface): {
  meshbot: MeshbotTool<unknown, string>;
  lcTool: StructuredToolInterface;
} {
  const meshbot: MeshbotTool<unknown, string> = {
    name: lcTool.name,
    description: lcTool.description ?? "",
    // schema 走 passthrough：实际校验交给 lcTool.invoke 内部。
    schema: z.any() as unknown as z.ZodType<unknown>,
    async execute(args: unknown, ctx: ToolContext): Promise<string> {
      // core 1.x：把已 abort 的 signal 传给 lcTool.invoke 会执行工具但 promise
      // 永不 settle（挂起泄漏）。入口先查 aborted——已取消就不该执行工具，直接抛。
      if (ctx.signal.aborted) {
        throw new Error(`工具 ${lcTool.name} 未执行：调用前已被取消`);
      }
      const result = await lcTool.invoke(args as never, {
        signal: ctx.signal,
      });
      if (typeof result === "string") return result;
      // LC tool 偶尔返 content block 数组或对象，统一序列化成字符串给 LLM。
      try {
        return JSON.stringify(result);
      } catch {
        return String(result);
      }
    },
  };
  return { meshbot, lcTool };
}
