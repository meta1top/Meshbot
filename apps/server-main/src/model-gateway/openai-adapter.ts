import {
  AIMessage,
  type AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import {
  convertLangChainToolCallToOpenAI,
  parseToolCall,
} from "@langchain/core/output_parsers/openai_tools";
import type { OpenAIChatRequest } from "@meshbot/types";

/**
 * 从各厂商 chunk/message 归一提取思考增量。
 * 读序：① contentBlocks 标准视图里 type:"reasoning"（1.x 跨厂商统一：DeepSeek/
 * Anthropic 实测在此路）② 兜底 additional_kwargs.reasoning_content（DeepSeek 兼容
 * 路；双路同时存在时只取 ①，防重复）。
 */
export function extractReasoningDelta(msg: AIMessage | AIMessageChunk): string {
  let fromBlocks = "";
  for (const block of msg.contentBlocks ?? []) {
    if (block.type === "reasoning" && typeof block.reasoning === "string") {
      fromBlocks += block.reasoning;
    }
  }
  if (fromBlocks) return fromBlocks;
  const ak = msg.additional_kwargs?.reasoning_content;
  return typeof ak === "string" ? ak : "";
}

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
        // assistant：入站 tool_calls 是 OpenAI 线格式（function.name/function.arguments<string>），
        // langchain AIMessage.tool_calls 要求顶层 name/args<object>——用 langchain 自带转换，
        // 否则 @langchain/openai 读 toolCall.name/.args 全是 undefined，多轮工具调用第二轮发给厂商 400。
        return new AIMessage({
          content,
          tool_calls: (m.tool_calls ?? [])
            .map((tc) => parseToolCall(tc, { returnId: true }))
            .filter((tc): tc is NonNullable<typeof tc> => tc != null),
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

/**
 * langchain UsageMetadata → OpenAI usage。字段缺失按 0 兜底；
 * total_tokens 缺失时用 input+output 兜底。
 */
function toOpenAIUsage(u: {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}) {
  const prompt = u.input_tokens ?? 0;
  const completion = u.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u.total_tokens ?? prompt + completion,
  };
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
          // 非流式同样带思考过程（字段语义同 toOpenAIChunk 的 delta.reasoning_content）。
          ...(extractReasoningDelta(msg)
            ? { reasoning_content: extractReasoningDelta(msg) }
            : {}),
          // langchain tool_calls 是 {name,args,id} 顶层形状，OpenAI 响应要 {id,type,function:{name,arguments<string>}}——
          // 同样用 langchain 自带转换（C-1 的镜像），否则端侧 SDK 读不到 .function，工具调用丢失。
          ...(msg.tool_calls?.length
            ? {
                tool_calls: msg.tool_calls.map((tc) =>
                  convertLangChainToolCallToOpenAI(tc),
                ),
              }
            : {}),
        },
        finish_reason: msg.tool_calls?.length ? "tool_calls" : "stop",
      },
    ],
    ...(msg.usage_metadata ? { usage: toOpenAIUsage(msg.usage_metadata) } : {}),
  };
}

/** 流式 delta → OpenAI chat.completion.chunk。 */
export function toOpenAIChunk(
  delta: {
    role?: string;
    content?: string;
    toolCalls?: unknown;
    reasoning?: string;
  },
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
          // OpenAI 流式约定：首帧 delta 带 role:"assistant"。端侧 langchain 据此
          // 把 chunk 建成 AIMessageChunk（后续无 role 的帧沿用该角色）；缺 role 会
          // 退化成 generic ChatMessageChunk，被消费方的 instanceof AIMessageChunk 丢弃。
          ...(delta.role ? { role: delta.role } : {}),
          // OpenAI 官方 chat completions 无思考字段（OpenAI 不下发思考原文）；
          // reasoning_content 是 DeepSeek 开头、多家跟进、端侧 ChatOpenAI 1.x
          // 原生解析的行业事实标准扩展。标准客户端会忽略未知字段。
          ...(delta.reasoning ? { reasoning_content: delta.reasoning } : {}),
          ...(delta.content != null ? { content: delta.content } : {}),
          ...(delta.toolCalls ? { tool_calls: delta.toolCalls } : {}),
        },
        finish_reason: null,
      },
    ],
  };
}

/**
 * OpenAI include_usage 约定的末尾帧：choices 空、带 usage。
 * 端侧 langchain ChatOpenAI 会把它解析进最终 AIMessageChunk 的 usage_metadata。
 */
export function toOpenAIUsageChunk(
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  },
  model: string,
  id: string,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [],
    usage: toOpenAIUsage(usage),
  };
}
