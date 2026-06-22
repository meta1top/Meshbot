import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
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
  resolveMessageId: (modelId: string) => string,
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
    // 剥掉 reasoning_content —— 否则下一轮回发时 deepseek thinking 模式会校验
    // 「reasoning_content 必须回传」，而 @langchain/openai 不会把
    // additional_kwargs.reasoning_content 塞回 messages[].reasoning_content。
    // reasoning 已实时流到前端 + 落库 session_messages，state 里无需保留。
    //
    // 重新 new AIMessage 而非 mutate accumulated.additional_kwargs：上游对 chunk
    // 引用/序列化路径不可控，直接构造一个干净对象最稳。
    const { reasoning_content, ...cleanKwargs } =
      (accumulated.additional_kwargs ?? {}) as Record<string, unknown>;
    void reasoning_content;
    const clean = new AIMessage({
      content: accumulated.content,
      tool_calls: accumulated.tool_calls,
      additional_kwargs: cleanKwargs,
      response_metadata: accumulated.response_metadata,
      // 模型生成的 UUID 映射为我方雪花：checkpointer 直接存雪花，
      // 与事件流 / session_messages 三处 id 收口一致。
      id: resolveMessageId(accumulated.id ?? ""),
      name: accumulated.name,
      usage_metadata: accumulated.usage_metadata,
    });
    return { messages: [clean] };
  };
}
