import { Annotation, StateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { supervisorNode } from "./nodes/supervisor.node";

const StateAnnotation = Annotation.Root({
  messages: Annotation<any[]>({
    reducer: (x, y) => x.concat(y),
    default: () => [],
  }),
});

export function buildSupervisorGraph(checkpointer: SqliteSaver) {
  const workflow = new StateGraph(StateAnnotation)
    .addNode("supervisor", supervisorNode)
    .addEdge("__start__", "supervisor")
    .addEdge("supervisor", "__end__");

  return workflow.compile({ checkpointer });
}
