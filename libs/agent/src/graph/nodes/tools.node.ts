import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import type { ToolRegistry } from "../../tools/tool-registry";
import type { ToolContext } from "../../tools/tool.types";
import type { GraphState } from "../graph.builder";

const RESULT_PREVIEW_LIMIT = 200;

/**
 * 自写 toolsNode：从 last AIMessage.tool_calls 取调用，按 name 调
 * registry.get()，传入 ctx 执行；结果以 ToolMessage append 到 state。
 *
 * 不用 langgraph 内置 ToolNode：内置 ToolNode 期望 tools[] 直接传入，无法
 * 在每次调用时注入 toolCallId / messageId 等动态 ctx。
 *
 * @param ctxGetter 由 GraphService 提供；每次进入节点时调，返回当下 ctx base。
 */
export function createToolsNode(
  registry: ToolRegistry,
  ctxGetter: () => Omit<ToolContext, "toolCallId">,
) {
  return async function toolsNode(
    state: GraphState,
  ): Promise<Partial<GraphState>> {
    const last = state.messages[state.messages.length - 1];
    if (!(last instanceof AIMessage) || !(last.tool_calls?.length ?? 0)) {
      return {};
    }
    const ctxBase = ctxGetter();
    const results: ToolMessage[] = [];
    for (const call of last.tool_calls ?? []) {
      const toolCallId = call.id ?? "";
      const tool = registry.get(call.name);
      if (!tool) {
        results.push(
          new ToolMessage({
            tool_call_id: toolCallId,
            name: call.name,
            content: `Error: unknown tool ${call.name}`,
          }),
        );
        continue;
      }
      const ctx: ToolContext = { ...ctxBase, toolCallId };
      ctxBase.emitter.emit(SESSION_WS_EVENTS.runToolCallStart, {
        sessionId: ctxBase.sessionId,
        messageId: ctxBase.messageId,
        toolCallId,
        name: call.name,
        args: call.args,
      });
      let content: string;
      let ok = true;
      try {
        const parsed = tool.schema.parse(call.args);
        const result = await tool.execute(parsed as never, ctx);
        content = typeof result === "string" ? result : JSON.stringify(result);
      } catch (err) {
        ok = false;
        content = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
      ctxBase.emitter.emit(SESSION_WS_EVENTS.runToolCallEnd, {
        sessionId: ctxBase.sessionId,
        messageId: ctxBase.messageId,
        toolCallId,
        name: call.name,
        ok,
        resultPreview: content.slice(0, RESULT_PREVIEW_LIMIT),
        content,
      });
      results.push(
        new ToolMessage({
          tool_call_id: toolCallId,
          name: call.name,
          content,
        }),
      );
    }
    return { messages: results };
  };
}
