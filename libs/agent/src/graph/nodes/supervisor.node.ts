import type { BaseMessage } from "@langchain/core/messages";

export interface SupervisorState {
  messages: BaseMessage[];
}

export async function supervisorNode(
  state: SupervisorState,
): Promise<Partial<SupervisorState>> {
  // Phase 1: Placeholder - will integrate LLM in Phase 2
  return { messages: state.messages };
}
