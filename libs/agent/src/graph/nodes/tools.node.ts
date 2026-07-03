import { type BaseMessage, ToolMessage } from "@langchain/core/messages";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import type { EventEmitter2 } from "@nestjs/event-emitter";
import type { ToolRegistry } from "../../tools/tool-registry";
import type { ToolContext } from "../../tools/tool.types";
import type { GraphState } from "../graph.builder";

/** AIMessage/AIMessageChunk 共享的 tool_calls 结构（按字段判，不用 instanceof）。 */
interface MessageWithToolCalls {
  tool_calls?: Array<{
    id?: string;
    name: string;
    args: unknown;
  }>;
}

const RESULT_PREVIEW_LIMIT = 200;

/**
 * 给 LLM（写进 checkpointer / ToolMessage）的 tool 结果上限。超过则截断，
 * 完整结果仍通过 run.tool_call_end 事件落到 session_messages（UI / 历史不受影响）。
 *
 * 主要为治 MCP 截图：take_screenshot 等返回几百 KB base64，对文本模型毫无用处
 * 却把单条 ToolMessage 撑到几十万 token，几轮就吃满上下文。32KB 足够容纳页面
 * a11y 快照等"有用的长文本结果"（实测 ~12-22KB），又能把 base64 截图砍掉 90%+。
 */
const TOOL_RESULT_LLM_LIMIT = 32_000;

/** 截断给 LLM 的 tool 结果：保留开头（含 MCP 的 "Took a screenshot" 之类文字说明）+ 提示。 */
export function capForLlm(content: string): string {
  if (content.length <= TOOL_RESULT_LLM_LIMIT) return content;
  return `${content.slice(0, 2000)}\n\n[工具结果过长，共 ${content.length} 字符，为节省上下文已截断；完整结果保存在会话历史中，可让用户在前端查看]`;
}

/**
 * 自写 toolsNode：从 last AIMessage.tool_calls 取调用，按 name 调
 * registry.get()，传入 ctx 执行；结果以 ToolMessage append 到 state。
 *
 * 不用 langgraph 内置 ToolNode：内置 ToolNode 期望 tools[] 直接传入，无法
 * 在每次调用时注入 toolCallId / messageId 等动态 ctx。
 *
 * sessionId / signal 从 LangGraph 在每次 graph.stream 注入的 RunnableConfig 取，
 * messageId 直接从携带 tool_calls 的那条 AIMessage 取。**不再依赖 GraphService
 * 上的单例 ctxRef**——后者在多 session 并发跑时会被覆盖，导致 tool 事件
 * emit 到错 session、tool result 写到错 session_messages。
 */
export function createToolsNode(
  registry: ToolRegistry,
  emitter: EventEmitter2,
) {
  return async function toolsNode(
    state: GraphState,
    config: LangGraphRunnableConfig,
  ): Promise<Partial<GraphState>> {
    // 用字段判 tool_calls，不用 instanceof —— monorepo 下 @langchain/core 可能
    // 多版本/多打包路径加载，AIMessageChunk 不会通过这边 import 的 AIMessage
    // instanceof，导致带 tool_calls 的消息被当作终态、tools 节点直接 noop。
    const last = state.messages[state.messages.length - 1] as
      | (BaseMessage & MessageWithToolCalls & { id?: string })
      | undefined;
    const toolCalls = last?.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return {};
    }
    // sessionId 走 LangGraph 的 configurable.thread_id —— 调用方 streamMessage
    // 里 `configurable: { thread_id: threadId }` 已经传了。
    const sessionId = config?.configurable?.thread_id;
    if (typeof sessionId !== "string" || !sessionId) {
      throw new Error(
        "toolsNode: config.configurable.thread_id 缺失或非字符串",
      );
    }
    // signal 由 LangGraph 从 graph.stream(..., { signal }) 透传过来，触发 abort
    // 时 tool 内的 await（含 MCP / 子进程）可以提前中断。fallback never-abort 仅
    // 防御性，runner 一定会传。
    const signal = config?.signal ?? new AbortController().signal;
    // messageId 取自携带 tool_calls 的那条 AIMessage —— 同轮内多 tool_call 共享。
    const messageId = last?.id ?? "";

    /** 执行单个 tool_call，返回对应 ToolMessage（保留所有事件与截断语义）。 */
    const runOne = async (call: {
      id?: string;
      name: string;
      args: unknown;
    }): Promise<ToolMessage> => {
      const toolCallId = call.id ?? "";
      const tool = registry.get(call.name);
      if (!tool) {
        return new ToolMessage({
          tool_call_id: toolCallId,
          name: call.name,
          content: `Error: unknown tool ${call.name}`,
        });
      }
      const ctx: ToolContext = {
        sessionId,
        messageId,
        toolCallId,
        emitter,
        signal,
      };
      emitter.emit(SESSION_WS_EVENTS.runToolCallStart, {
        sessionId,
        messageId,
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
      // content = 完整结果（→ run.tool_call_end → session_messages / UI）
      // llmContent = 截断后给 LLM 的那份（→ ToolMessage → checkpointer）
      const llmContent = capForLlm(content);
      emitter.emit(SESSION_WS_EVENTS.runToolCallEnd, {
        sessionId,
        messageId,
        toolCallId,
        name: call.name,
        ok,
        resultPreview: content.slice(0, RESULT_PREVIEW_LIMIT),
        content,
      });
      return new ToolMessage({
        tool_call_id: toolCallId,
        name: call.name,
        content: llmContent,
      });
    };
    // 同轮 tool_calls 并发执行（相互独立）；Promise.all 保持数组顺序 = tool_calls 顺序，
    // 保证每个 tool_call → 对应 ToolMessage 配对与顺序不乱。
    const results = await Promise.all(toolCalls.map(runOne));
    return { messages: results };
  };
}
