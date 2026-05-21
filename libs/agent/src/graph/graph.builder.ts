import type { BaseMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import {
  createSupervisorNode,
  type ModelProvider,
} from "./nodes/supervisor.node";

export interface GraphState {
  messages: BaseMessage[];
}

/** 构建 supervisor 单节点图。modelProvider 惰性提供 LLM。 */
export function buildSupervisorGraph(
  checkpointer: SqliteSaver,
  modelProvider: ModelProvider,
) {
  return new StateGraph<GraphState>({
    channels: {
      messages: {
        value: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
        default: () => [],
      },
    },
  })
    .addNode("supervisor", createSupervisorNode(modelProvider))
    .addEdge(START, "supervisor")
    .addEdge("supervisor", END)
    .compile({ checkpointer });
}
