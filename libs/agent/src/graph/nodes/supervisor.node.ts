import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";

export interface SupervisorState {
  messages: BaseMessage[];
}

/** 惰性提供 chat model 的工厂（每次 run 取最新凭证）。 */
export type ModelProvider = () => Promise<BaseChatModel>;

/**
 * 创建 supervisor 节点：把当前消息历史交给 LLM，流式产出一条 AIMessage。
 *
 * model 经工厂惰性获取，便于按 run 取最新 ModelConfig，也便于测试注入 fake。
 * 节点用 model.stream() 逐 token 产出 —— 在 LangGraph streamMode:"messages"
 * 下每个 chunk 会实时冒泡到图的消息流，实现真正的 token 级流式。
 * 节点累加所有 chunk 成完整 AIMessage 返回，交由 reducer concat 进 state。
 */
export function createSupervisorNode(modelProvider: ModelProvider) {
  return async function supervisorNode(
    state: SupervisorState,
  ): Promise<Partial<SupervisorState>> {
    const model = await modelProvider();
    if (!model) {
      throw new Error("supervisor 节点未拿到可用 LLM：modelProvider 返回空");
    }
    const stream = await model.stream(state.messages);
    let accumulated: AIMessageChunk | undefined;
    for await (const chunk of stream) {
      accumulated =
        accumulated === undefined ? chunk : accumulated.concat(chunk);
    }
    if (accumulated === undefined) {
      throw new Error("supervisor 节点：LLM 流未产出任何内容");
    }
    return { messages: [accumulated] };
  };
}
