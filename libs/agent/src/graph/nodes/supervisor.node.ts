import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";

export interface SupervisorState {
  messages: BaseMessage[];
}

/** 惰性提供 chat model 的工厂（每次 run 取最新凭证）。 */
export type ModelProvider = () => Promise<BaseChatModel>;

/** 惰性提供 LangChain bindable tools 数组。 */
export type ToolsProvider = () => StructuredToolInterface[];

/**
 * 创建 supervisor 节点：当前消息历史交给 LLM，流式产出一条 AIMessage。
 *
 * model 经工厂惰性获取；tools 数组每次 run 重新拿（支持后续动态注册）。
 * model.bindTools(tools) 让 LLM 能产 tool_calls。
 * 节点累加所有 chunk 成完整 AIMessage 返回；交由 reducer concat 进 state。
 */
export function createSupervisorNode(
  modelProvider: ModelProvider,
  toolsProvider: ToolsProvider,
) {
  return async function supervisorNode(
    state: SupervisorState,
  ): Promise<Partial<SupervisorState>> {
    const model = await modelProvider();
    if (!model) {
      throw new Error("supervisor 节点未拿到可用 LLM：modelProvider 返回空");
    }
    const tools = toolsProvider();
    const withTools =
      tools.length > 0 && typeof model.bindTools === "function"
        ? model.bindTools(tools)
        : model;
    const stream = await withTools.stream(state.messages);
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
