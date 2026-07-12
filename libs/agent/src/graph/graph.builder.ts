import type { BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { EventEmitter2 } from "@nestjs/event-emitter";
import type { ToolRegistry } from "../tools/tool-registry";
import {
  createSupervisorNode,
  type ModelProvider,
} from "./nodes/supervisor.node";
import { createToolsNode } from "./nodes/tools.node";

/**
 * 主图 state 定义：messages 经 mergeMessages 归并（append + 同 id 原地替换 +
 * RemoveMessage 删除）。langgraph 1.x 起 {channels} 构造重载已 @deprecated，
 * 迁 Annotation.Root（官方迁移第一档，reducer 语义 1:1）。
 */
export const GraphAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: mergeMessages,
    default: () => [],
  }),
});

/** 图 state 类型：从 Annotation 派生（形状仍是 { messages: BaseMessage[] }）。 */
export type GraphState = typeof GraphAnnotation.State;

/** 按名字过滤 bindable 工具列表（子 Agent 用来排除 dispatch_subagent，实现一层嵌套）。 */
export function filterBindable(
  tools: StructuredToolInterface[],
  excludeToolNames?: ReadonlySet<string>,
): StructuredToolInterface[] {
  if (!excludeToolNames || excludeToolNames.size === 0) return tools;
  return tools.filter((t) => !excludeToolNames.has(t.name));
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
  // 结构判定而非 instanceof：core 1.x 双构建（ESM/CJS）下跨模块系统的
  // RemoveMessage 类不同源，instanceof 会假阴性（同 graph-runner 的
  // isAIMessageChunk 改造）；core 1.x 未导出 isRemoveMessage guard，用 _getType。
  const isRemove = (m: BaseMessage): boolean => m._getType() === "remove";
  const removeIds = new Set<string>();
  for (const m of y) {
    if (isRemove(m) && m.id) removeIds.add(m.id);
  }
  const incoming = y.filter((m) => !isRemove(m));
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
 * @param resolveMessageId 模型 UUID → 雪花 id 映射函数
 * @param excludeToolNames 从可绑定工具集排除的工具名列表，用于子 Agent 去掉 dispatch_subagent 实现一层嵌套
 */
export function buildSupervisorGraph(
  checkpointer: SqliteSaver,
  modelProvider: ModelProvider,
  registry: ToolRegistry,
  emitter: EventEmitter2,
  resolveMessageId: (modelId: string) => string,
  excludeToolNames?: ReadonlySet<string>,
) {
  const supervisor = createSupervisorNode(
    modelProvider,
    () => filterBindable(registry.asLangChainBindable(), excludeToolNames),
    resolveMessageId,
  );
  const tools = createToolsNode(registry, emitter);
  return new StateGraph(GraphAnnotation)
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
