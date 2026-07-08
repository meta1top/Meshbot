import { Injectable } from "@nestjs/common";
import type { OpenAIChatRequest } from "@meshbot/types";
import { OrgModelConfigService } from "@meshbot/main";
import { initChatModel } from "langchain/chat_models/universal";
import {
  toLangchainMessages,
  toModelParams,
  toOpenAICompletion,
} from "./openai-adapter";

/** 网关内部：按 orgId+modelId 找不到归属模型（含 deepseek v1 不经网关）时抛出，Controller 映射 404/403。 */
export class GatewayModelNotFoundError extends Error {}

// provider 名映射与 libs/agent llm.factory.ts:15-22 保持一致
const PROVIDER_MODEL_NAME: Record<string, string> = {
  google: "google-genai",
  "openai-compatible": "openai",
};

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

  /** 内部：按 resolved 建 langchain 模型（Task 5 流式复用）。 */
  private async build(
    resolved: Awaited<ReturnType<OrgModelConfigService["resolveDecrypted"]>>,
    req: OpenAIChatRequest,
    streaming: boolean,
  ) {
    if (!resolved) throw new GatewayModelNotFoundError(req.model);
    // DeepSeek v1 不经网关，仍端侧直连——网关侧一律当作"模型不存在"拒绝。
    if (resolved.providerType === "deepseek") {
      throw new GatewayModelNotFoundError(req.model);
    }
    const configuration: Record<string, unknown> = {};
    if (resolved.baseUrl) configuration.baseURL = resolved.baseUrl;
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
