import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { Injectable, Optional } from "@nestjs/common";
import { AccountContextService } from "../account/account-context.service";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import {
  type ActiveModelConfig,
  CLOUD_GATEWAY_API_KEY_PLACEHOLDER,
  readActiveModelConfig,
  readModelConfigById,
} from "../config/model-config.reader";
import { createChatModel } from "./llm.factory";
import { ModelRunContext } from "./model-run-context";
import type { ModelProvider } from "./nodes/supervisor.node";

/**
 * 负责解析、缓存当前账号的 chat model，并暴露 provider/meta 给 GraphService 及后续消费者。
 *
 * 字段说明：
 * - modelMeta：当前活跃模型的 providerType/model，resolveModel() 时刷新，供 usage 事件标注。
 * - modelCache：按配置 key 缓存 BaseChatModel 实例，避免每次调用重新初始化（~200ms）。
 * - overrideProvider：测试注入的假 provider；非空时 provider() 直接返回它，跳过 DB 读取。
 */
@Injectable()
export class ModelResolver {
  private modelMeta: { providerType: string; model: string };
  private readonly modelCache = new Map<string, BaseChatModel>();
  private readonly overrideProvider?: ModelProvider;

  constructor(
    private readonly config: MeshbotConfigService,
    private readonly account: AccountContextService,
    private readonly runCtx: ModelRunContext,
    @Optional() overrideProvider?: ModelProvider,
    @Optional() overrideMeta?: { providerType: string; model: string },
  ) {
    this.modelMeta = overrideMeta ?? {
      providerType: "unknown",
      model: "unknown",
    };
    this.overrideProvider = overrideProvider;
  }

  /** 返回最终使用的 ModelProvider（测试注入优先，否则包装 resolveModel）。 */
  provider(): ModelProvider {
    return this.overrideProvider ?? (() => this.resolveModel());
  }

  /** 当前 run 的模型 meta（run 上下文优先；无上下文回落共享字段——title 等旁路径）。 */
  getMeta(): { providerType: string; model: string } {
    return this.runCtx.getMeta() ?? this.modelMeta;
  }

  /**
   * 按当前 agent.db 的启用 ModelConfig（或 run 上下文指定的覆盖 ModelConfig）
   * 构造 chat model。
   *
   * 命中缓存直接返回；key 把可能影响行为的字段都拼上，配置变化自动 miss。
   */
  async resolveModel(): Promise<BaseChatModel> {
    const dbPath = this.config.getDatabasePath();
    const acct = this.account.getOrThrow();
    const overrideId = this.runCtx.getOverrideId();
    const cfg = overrideId
      ? readModelConfigById(dbPath, acct, overrideId)
      : readActiveModelConfig(dbPath, acct);
    if (!cfg) {
      throw new Error(
        overrideId
          ? `指定的模型配置不存在：${overrideId}（可能已被删除）`
          : "当前账号没有启用的模型配置，请先在设置中配置模型",
      );
    }
    const meta = { providerType: cfg.providerType, model: cfg.model };
    this.modelMeta = meta;
    this.runCtx.setMeta(meta);
    const key = modelCacheKey(cfg);
    const cached = this.modelCache.get(key);
    if (cached) return cached;
    const model = await createChatModel(cfg);
    this.modelCache.set(key, model);
    return model;
  }

  /**
   * 给 SessionTitleService 用的标题模型：复用 enabled model 凭证，但
   * - streaming: false（一次性 invoke 不需要流式开销）
   * - 关掉 deepseek thinking（标题用例不需要 reasoning，关掉可减少 ~1s 思考
   *   时间 + 节省 token；非 deepseek provider 不传 thinking 参数）
   *
   * 独立 cache key 跟主 graph model 共存，避免互相覆盖。
   */
  async getTitleModel(): Promise<BaseChatModel> {
    const cfg = readActiveModelConfig(
      this.config.getDatabasePath(),
      this.account.getOrThrow(),
    );
    if (!cfg) {
      throw new Error("当前账号没有启用的模型配置，请先在设置中配置模型");
    }
    const key = `title|${modelCacheKey(cfg)}`;
    const cached = this.modelCache.get(key);
    if (cached) return cached;
    const modelKwargs =
      cfg.providerType === "deepseek"
        ? { thinking: { type: "disabled" } }
        : undefined;
    const model = await createChatModel(cfg, {
      streaming: false,
      modelKwargs,
    });
    this.modelCache.set(key, model);
    return model;
  }

  /**
   * 调摘要 LLM。serialized 已经是拍扁的对话文本（含 [user]/[assistant]/[tool]
   * 前缀、tool result 截断等），由调用方负责。这里只关心把 system prompt +
   * 用户串组合后丢给 enabled model invoke，并截 maxTokens。
   *
   * 用 AbortController 实现 timeoutMs；超时直接抛 Error("Summarize timeout")。
   */
  async summarize(
    serialized: string,
    opts: { systemPrompt: string; timeoutMs: number; maxTokens: number },
  ): Promise<string> {
    const model = await this.provider()();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const resp = await model.invoke(
        [new SystemMessage(opts.systemPrompt), new HumanMessage(serialized)],
        { signal: controller.signal, maxTokens: opts.maxTokens } as never,
      );
      const content = resp.content;
      return typeof content === "string" ? content : JSON.stringify(content);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * 按配置算 model 缓存 key。云网关模型（`isCloudModel`）固定拼占位符而非
 * `cfg.apiKey`——虽然该字段本就只存占位符、从不落地真实 device token，但
 * 显式排除能防住"万一 apiKey 字段将来意外携带真实 token"的缓存串号风险，
 * 语义上也更清楚地表达"token 轮换不该使 client 缓存复用错误的实例"。
 */
function modelCacheKey(cfg: ActiveModelConfig): string {
  const apiKeyPart = cfg.isCloudModel
    ? CLOUD_GATEWAY_API_KEY_PLACEHOLDER
    : (cfg.apiKey ?? "");
  return `${cfg.providerType}|${cfg.model}|${cfg.baseUrl ?? ""}|${apiKeyPart}`;
}
