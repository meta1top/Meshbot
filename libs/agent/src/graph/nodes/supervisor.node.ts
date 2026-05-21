import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";

export interface SupervisorState {
  messages: BaseMessage[];
}

/** 惰性提供 chat model 的工厂（每次 run 取最新凭证）。 */
export type ModelProvider = () => Promise<BaseChatModel>;

/**
 * 创建 supervisor 节点：把当前消息历史交给 LLM，产出一条 AIMessage。
 *
 * model 经工厂惰性获取，便于按 run 取最新 ModelConfig，也便于测试注入 fake。
 * 节点只返回新增的 AIMessage —— graph 的 reducer 负责 concat 进 state。
 */
export function createSupervisorNode(modelProvider: ModelProvider) {
  return async function supervisorNode(
    state: SupervisorState,
  ): Promise<Partial<SupervisorState>> {
    const model = await modelProvider();
    const reply = await model.invoke(state.messages);
    return { messages: [reply] };
  };
}
