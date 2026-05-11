import type { BaseMessage } from "@langchain/core/messages";
import { END, START, StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { supervisorNode } from "./nodes/supervisor.node";

export interface GraphState {
  messages: BaseMessage[];
}

export function buildSupervisorGraph(checkpointer: SqliteSaver) {
  return new StateGraph<GraphState>({
    channels: {
      messages: {
        value: (x: BaseMessage[], y: BaseMessage[]) => x.concat(y),
        default: () => [],
      },
    },
  })
    .addNode("supervisor", supervisorNode)
    .addEdge(START, "supervisor")
    .addEdge("supervisor", END)
    .compile({ checkpointer });
}
