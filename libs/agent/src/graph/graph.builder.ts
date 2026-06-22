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
        // 默认 append；遇到 RemoveMessage(id) 则从 base 删该 id（让 sanitize
        // 能剪掉孤儿 tool_calls 等脏 trailing message，让 retry 不再循环挂）。
        value: (x: BaseMessage[], y: BaseMessage[]) => {
          const removeIds = new Set<string>();
          for (const m of y) {
            if (m instanceof RemoveMessage && m.id) removeIds.add(m.id);
          }
          const kept = x.filter((m) => !m.id || !removeIds.has(m.id));
          const appended = y.filter((m) => !(m instanceof RemoveMessage));
          return kept.concat(appended);
        },
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
