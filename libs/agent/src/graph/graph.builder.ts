import type { BaseMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { supervisorNode } from "./nodes/supervisor.node";

export interface GraphState {
  messages: BaseMessage[];
}

export const StateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (left: BaseMessage[], right: BaseMessage | BaseMessage[]) => {
      if (Array.isArray(right)) {
        return left.concat(right);
      }
      return left.concat([right]);
    },
    default: () => [],
  }),
});

export function buildSupervisorGraph(checkpointer: SqliteSaver) {
  const graph = new StateGraph(StateAnnotation)
    .addNode("supervisor", supervisorNode)
    .addEdge(START, "supervisor")
    .addEdge("supervisor", END);

  return graph.compile({ checkpointer });
}
