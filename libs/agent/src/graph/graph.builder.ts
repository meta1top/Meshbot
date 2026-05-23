import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { ToolRegistry } from "../tools/tool-registry";
import type { ToolContext } from "../tools/tool.types";
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
 * @param toolsCtxGetter 由 GraphService 提供；返回当下 ctx base（不含 toolCallId，
 *   toolCallId 在 toolsNode 内按 tool_call 现取）
 */
export function buildSupervisorGraph(
  checkpointer: SqliteSaver,
  modelProvider: ModelProvider,
  registry: ToolRegistry,
  toolsCtxGetter: () => Omit<ToolContext, "toolCallId">,
) {
  const supervisor = createSupervisorNode(modelProvider, () =>
    registry.asLangChainBindable(),
  );
  const tools = createToolsNode(registry, toolsCtxGetter);
  return new StateGraph<GraphState>({
    channels: {
      messages: {
        value: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
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

function routeAfterSupervisor(state: GraphState): "tools" | typeof END {
  const last = state.messages[state.messages.length - 1];
  if (last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0) {
    return "tools";
  }
  return END;
}
