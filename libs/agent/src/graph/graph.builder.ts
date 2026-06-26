import { type BaseMessage, RemoveMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { EventEmitter2 } from "@nestjs/event-emitter";
import type { ToolRegistry } from "../tools/tool-registry";
import {
  createSupervisorNode,
  type ModelProvider,
} from "./nodes/supervisor.node";
import { createToolsNode } from "./nodes/tools.node";

export interface GraphState {
  messages: BaseMessage[];
}

/**
 * messages 通道 reducer。
 * - `RemoveMessage(id)` → 从 base 删除该 id（sanitize 剪孤儿 tool_calls / 压缩 / regenerate 用）
 * - 非 Remove 且 id 已存在 → **原地替换**（如 system:ctx / system:skills 每轮刷新，
 *   位置不变、利于 prompt 缓存，无需先 Remove 再 Add）
 * - 新 id → 追加到末尾
 *
 * 同批「`RemoveMessage(id)` + 同 id 新消息」→ 先删原位、再追加到末尾
 * （等价旧的 remove-then-add，保持向后兼容）。
 */
export function mergeMessages(
  x: BaseMessage[],
  y: BaseMessage[],
): BaseMessage[] {
  const removeIds = new Set<string>();
  for (const m of y) {
    if (m instanceof RemoveMessage && m.id) removeIds.add(m.id);
  }
  const incoming = y.filter((m) => !(m instanceof RemoveMessage));
  const incomingById = new Map<string, BaseMessage>();
  for (const m of incoming) {
    if (m.id) incomingById.set(m.id, m);
  }
  const result: BaseMessage[] = [];
  const replaced = new Set<string>();
  for (const m of x) {
    if (m.id && removeIds.has(m.id)) continue; // 被删除
    if (m.id && incomingById.has(m.id)) {
      // 原地替换（id 既被删又被替换的情况上面 removeIds 已先行 continue）
      const next = incomingById.get(m.id);
      if (next) result.push(next);
      replaced.add(m.id);
    } else {
      result.push(m);
    }
  }
  for (const m of incoming) {
    if (m.id && replaced.has(m.id)) continue; // 已就地替换，不再追加
    result.push(m);
  }
  return result;
}

/**
 * 构建 supervisor + tools 双节点图，ReAct 循环：
 *
 *   START → supervisor → [tool_calls?] → tools → supervisor → … → END
 *
 * @param modelProvider 每次 run 取最新 LLM
 * @param registry tool 注册表（启动期注册完毕）
 * @param emitter 进程内 EventEmitter（用于 toolsNode emit run.tool_call_* 事件，
 *   session 无关 → 构造期一次性注入即可）
 */
export function buildSupervisorGraph(
  checkpointer: SqliteSaver,
  modelProvider: ModelProvider,
  registry: ToolRegistry,
  emitter: EventEmitter2,
  resolveMessageId: (modelId: string) => string,
) {
  const supervisor = createSupervisorNode(
    modelProvider,
    () => registry.asLangChainBindable(),
    resolveMessageId,
  );
  const tools = createToolsNode(registry, emitter);
  return new StateGraph<GraphState>({
    channels: {
      messages: {
        // 见 mergeMessages：append + 同 id 原地替换 + RemoveMessage 按 id 删除。
        value: mergeMessages,
        default: () => [],
      },
    },
  })
    .addNode("supervisor", supervisor)
    .addNode("tools", tools)
    .addEdge(START, "supervisor")
    .addConditionalEdges("supervisor", routeAfterSupervisor)
    .addEdge("tools", "supervisor")
    .compile({ checkpointer });
}

/**
 * 用结构字段判 tool_calls，不用 `instanceof AIMessage` —— monorepo 下
 * @langchain/core 可能被多版本/多打包路径加载，AIMessageChunk 与上层 import
 * 的 AIMessage 不同源时 instanceof 会假阴性，导致带 tool_calls 的消息被
 * 误判为终态、跳到 END，tools 节点永远不会被触发。
 */
function routeAfterSupervisor(state: GraphState): "tools" | typeof END {
  const last = state.messages[state.messages.length - 1] as
    | (BaseMessage & { tool_calls?: unknown[] })
    | undefined;
  if (last && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) {
    return "tools";
  }
  return END;
}
