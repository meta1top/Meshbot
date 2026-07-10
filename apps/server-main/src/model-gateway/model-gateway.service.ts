import { Injectable } from "@nestjs/common";
import type { OpenAIChatRequest } from "@meshbot/types";
import { type ResolvedModel, OrgModelConfigService } from "@meshbot/main";
import { initChatModel } from "langchain/chat_models/universal";
import type { ToolCallChunk } from "@langchain/core/messages/tool";
import {
  toLangchainMessages,
  toModelParams,
  toOpenAIChunk,
  toOpenAICompletion,
} from "./openai-adapter";
import { deepseekReasoningFetch } from "./deepseek-fetch";

/** 网关内部：按 orgId+modelId 找不到归属模型时抛出，Controller 映射 404/403。 */
export class GatewayModelNotFoundError extends Error {}

// provider 名映射与 libs/agent llm.factory.ts:15-22 保持一致
const PROVIDER_MODEL_NAME: Record<string, string> = {
  google: "google-genai",
  "openai-compatible": "openai",
};

/**
 * langchain `AIMessageChunk.tool_call_chunks` → OpenAI 流式 `delta.tool_calls` 映射。
 * 实测校准：langchain 每帧携带 `{name?, args?, id?, index}`（增量片段，按 index 累加），
 * OpenAI 线上格式为 `{index, id?, type:"function", function:{name?, arguments}}`。
 */
function toOpenAIToolCallDeltas(
  chunks: ToolCallChunk[] | undefined,
): object[] | undefined {
  if (!chunks?.length) return undefined;
  return chunks.map((c) => ({
    index: c.index ?? 0,
    ...(c.id ? { id: c.id } : {}),
    type: "function" as const,
    function: {
      ...(c.name ? { name: c.name } : {}),
      arguments: c.args ?? "",
    },
  }));
}

/** 云端模型网关：编排 org 模型解析 → langchain 厂商调用 → OpenAI 兼容响应。 */
@Injectable()
export class ModelGatewayService {
  constructor(private readonly orgModels: OrgModelConfigService) {}

  /** 非流式：解析 org 模型 → 解密 → 调厂商 → OpenAI completion。 */
  async complete(
    orgId: string,
    req: OpenAIChatRequest,
    id: string,
  ): Promise<object> {
    const resolved = await this.orgModels.resolveDecrypted(orgId, req.model);
    if (!resolved) throw new GatewayModelNotFoundError(req.model);
    const model = await this.build(resolved, req, false);
    const result = await model.invoke(toLangchainMessages(req));
    return toOpenAICompletion(result, req.model, id);
  }

  /** 流式：解析 org 模型 → 解密 → 调厂商 stream → 逐 chunk 产出 OpenAI chat.completion.chunk。 */
  async *stream(
    orgId: string,
    req: OpenAIChatRequest,
    id: string,
  ): AsyncGenerator<object> {
    const resolved = await this.orgModels.resolveDecrypted(orgId, req.model);
    if (!resolved) throw new GatewayModelNotFoundError(req.model);
    const model = await this.build(resolved, req, true);
    // 首个产出帧带 role:"assistant"（OpenAI 流式约定），后续帧不再带——见
    // openai-adapter.toOpenAIChunk 注释：缺 role 端侧会解析成 generic chunk 而丢弃。
    let firstDelta = true;
    for await (const chunk of await model.stream(toLangchainMessages(req))) {
      const content = typeof chunk.content === "string" ? chunk.content : "";
      const toolCalls = toOpenAIToolCallDeltas(
        (chunk as { tool_call_chunks?: ToolCallChunk[] }).tool_call_chunks,
      );
      if (content || toolCalls) {
        yield toOpenAIChunk(
          { ...(firstDelta ? { role: "assistant" } : {}), content, toolCalls },
          req.model,
          id,
        );
        firstDelta = false;
      }
    }
    yield {
      id,
      object: "chat.completion.chunk",
      created: 0,
      model: req.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
  }

  /** 内部：按 resolved 建 langchain 模型（Task 5 流式复用）。 */
  private async build(
    resolved: ResolvedModel,
    req: OpenAIChatRequest,
    streaming: boolean,
  ) {
    if (!resolved) throw new GatewayModelNotFoundError(req.model);
    const configuration: Record<string, unknown> = {};
    if (resolved.baseUrl) configuration.baseURL = resolved.baseUrl;
    // DeepSeek thinking 模式要求历史 assistant 消息带 reasoning_content，
    // @langchain/openai 序列化时不回写——拦 fetch 补空字段（详见 deepseek-fetch.ts）。
    if (resolved.providerType === "deepseek") {
      configuration.fetch = deepseekReasoningFetch(globalThis.fetch);
    }
    const model = await initChatModel(resolved.model, {
      modelProvider:
        PROVIDER_MODEL_NAME[resolved.providerType] ?? resolved.providerType,
      apiKey: resolved.apiKey,
      streaming,
      ...toModelParams(req), // temperature/maxTokens 顶层参数
      ...(Object.keys(configuration).length ? { configuration } : {}),
    });
    // 工具走 bindTools（而非 modelKwargs），返回的 Runnable 同样有 invoke/stream
    return req.tools?.length
      ? (model.bindTools(req.tools) as unknown as typeof model)
      : model;
  }
}
