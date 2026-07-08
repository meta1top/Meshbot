import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { OpenAIChatRequest } from "@meshbot/types";

/** OpenAI messages → langchain BaseMessage[]。 */
export function toLangchainMessages(req: OpenAIChatRequest): BaseMessage[] {
  return req.messages.map((m) => {
    const content = m.content ?? "";
    switch (m.role) {
      case "system":
        return new SystemMessage(content);
      case "user":
        return new HumanMessage(content);
      case "tool":
        return new ToolMessage({ content, tool_call_id: m.tool_call_id ?? "" });
      default:
        return new AIMessage({
          content,
          tool_calls: (m.tool_calls as never) ?? undefined,
        });
    }
  });
}

/**
 * 从 OpenAI 请求提取 initChatModel 的顶层生成参数（temperature/max_tokens）。
 * 注意：tools 不走这里——见 Task 3 用 model.bindTools(req.tools)。
 *
 * @public-api Task 3（网关调用 langchain 模型处）消费此函数；本任务只负责产出。
 */
export function toModelParams(req: OpenAIChatRequest): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (req.temperature != null) p.temperature = req.temperature;
  if (req.max_tokens != null) p.maxTokens = req.max_tokens;
  return p;
}

function textOf(content: unknown): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** 非流式 AIMessage → OpenAI chat.completion。 */
export function toOpenAICompletion(msg: AIMessage, model: string, id: string) {
  return {
    id,
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: textOf(msg.content),
          ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
        },
        finish_reason: msg.tool_calls?.length ? "tool_calls" : "stop",
      },
    ],
  };
}

/** 流式 delta → OpenAI chat.completion.chunk。 */
export function toOpenAIChunk(
  delta: { content?: string; toolCalls?: unknown },
  model: string,
  id: string,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        delta: {
          ...(delta.content != null ? { content: delta.content } : {}),
          ...(delta.toolCalls ? { tool_calls: delta.toolCalls } : {}),
        },
        finish_reason: null,
      },
    ],
  };
}
