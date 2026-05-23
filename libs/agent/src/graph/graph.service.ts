import { randomUUID } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import {
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { Injectable, Optional } from "@nestjs/common";
import { createSqliteCheckpointer } from "../checkpoint/sqlite-checkpointer";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { readActiveModelConfig } from "../config/model-config.reader";
import { PromptService } from "../prompt/prompt.service";
import type { GraphState } from "./graph.builder";
import { buildSupervisorGraph } from "./graph.builder";
import { createChatModel } from "./llm.factory";
import type { ModelProvider } from "./nodes/supervisor.node";

export interface AgentConfig {
  model: string;
  temperature?: number;
  systemPrompt?: string;
  tools?: string[];
}

export type ThreadId = string;

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  /**
   * 推理模型（DeepSeek 等）的思考过程，来源于 AIMessage.additional_kwargs.reasoning_content。
   * checkpointer 一直会持久化它，刷新会话也能拿回；非推理模型为 undefined。
   */
  reasoning?: string;
}

/**
 * 流式 run 产出的事件：
 * - human：本批次每条 user 消息以 HumanMessage 形式写入 checkpointer 时各 yield 一次；
 * - reasoning：单个 reasoning token（DeepSeek 等推理模型先吐 reasoning 再吐 content）；
 * - chunk：单个 assistant content token；
 * - usage：调用结束的 token 用量。
 */
export type StreamChunk =
  | { kind: "human"; messageId: string }
  | { kind: "reasoning"; messageId: string; delta: string }
  | { kind: "chunk"; messageId: string; delta: string }
  | {
      kind: "usage";
      messageId: string;
      providerType: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      reasoningTokens: number;
      durationMs: number;
    };

@Injectable()
export class GraphService {
  private checkpointer: ReturnType<typeof createSqliteCheckpointer>;
  private graph: ReturnType<typeof buildSupervisorGraph>;
  private modelMeta: { providerType: string; model: string };
  /**
   * 缓存 chat model 实例。key 由 provider/model/baseUrl/apiKey 拼成，配置变化
   * 自动 miss。避免每次 runOnce 都 initChatModel 动态加载包（~200ms / 次）。
   */
  private modelCache = new Map<string, BaseChatModel>();

  constructor(
    private configService: MeshbotConfigService,
    private promptService: PromptService,
    @Optional() modelProvider?: ModelProvider,
    @Optional() modelMeta?: { providerType: string; model: string },
  ) {
    const dbPath = this.configService.getDatabasePath();
    this.checkpointer = createSqliteCheckpointer(dbPath);
    const provider: ModelProvider =
      modelProvider ?? (() => this.resolveModel());
    this.graph = buildSupervisorGraph(this.checkpointer, provider);
    this.modelMeta = modelMeta ?? { providerType: "unknown", model: "unknown" };
  }

  /**
   * 按当前 agent.db 的启用 ModelConfig 构造 chat model。
   *
   * 命中缓存直接返回；key 把可能影响行为的字段都拼上，配置变化自动 miss。
   */
  private async resolveModel(): Promise<BaseChatModel> {
    const cfg = readActiveModelConfig(this.configService.getDatabasePath());
    if (!cfg) {
      throw new Error(
        "没有启用的模型配置（model_configs 表为空或全部 disabled）",
      );
    }
    this.modelMeta = { providerType: cfg.providerType, model: cfg.model };
    const key = `${cfg.providerType}|${cfg.model}|${cfg.baseUrl ?? ""}|${cfg.apiKey ?? ""}`;
    const cached = this.modelCache.get(key);
    if (cached) return cached;
    const model = await createChatModel(cfg);
    this.modelCache.set(key, model);
    return model;
  }

  /**
   * 创建会话，返回 thread id。
   *
   * 仅生成 UUID；system prompt 在每次 streamMessage 时按需前置，
   * 不在此处写入 checkpointer（checkpointer.put 直写 API 易出错）。
   * config 当前完全未使用（含 systemPrompt —— 系统提示统一由 PromptService 提供）；
   * 保留入参便于后续接入 temperature / model。
   */
  async startSession(_config: AgentConfig): Promise<ThreadId> {
    const threadId = randomUUID();
    return threadId;
  }

  /**
   * 向会话发送一批消息并逐 token 流式产出 assistant 回复。
   *
   * 每条入参构造一条带显式 id 的 HumanMessage（id = 调用方的 PendingMessage.id），
   * 让 checkpointer 里的 user 消息与 pending 表可对齐去重。
   * system prompt 仅在首轮注入（无历史时），避免在 checkpointer 状态里重复累加。
   * 透传 signal 支持中断。
   *
   * @param inputs 至少一条 —— 调用方保证非空批次。
   */
  async *streamMessage(
    threadId: ThreadId,
    inputs: { id: string; content: string }[],
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    this.promptService.reloadIfChanged();
    const systemPrompt = this.promptService.getPrompt("system");
    const state = await this.graph.getState({
      configurable: { thread_id: threadId },
    });
    const hasHistory =
      Array.isArray((state.values as GraphState)?.messages) &&
      (state.values as GraphState).messages.length > 0;
    const inputMessages: BaseMessage[] = [];
    if (systemPrompt && !hasHistory) {
      inputMessages.push(new SystemMessage(systemPrompt));
    }
    for (const input of inputs) {
      inputMessages.push(
        new HumanMessage({ content: input.content, id: input.id }),
      );
    }
    // 先把本批次 user 消息以 human 事件 yield 出去，runner 据此 emit run.human，
    // 让 frontend 在 chunk 到达之前把 user 气泡从 pending 区迁到聊天区末尾，
    // 保证 user → assistant 视觉顺序与 checkpointer 状态一致。
    for (const input of inputs) {
      yield { kind: "human", messageId: input.id };
    }
    yield* this.runGraphStream(threadId, { messages: inputMessages }, signal);
  }

  /**
   * 不加新消息，从 checkpointer 现有状态恢复并流式产出 assistant 回复。
   *
   * 用于重试 —— failed 消息的 HumanMessage 已在会话里（最后一条），
   * 重试只让 graph 基于现有状态重跑产出回复。
   *
   * 传 `{ messages: [] }` 而非 `null`：已完成的图没有 pending task，
   * `stream(null)` 会原地返回不重跑；给一个空 messages 输入（concat reducer
   * 对空数组无副作用，不新增 user 消息）才会触发 START → supervisor 重新跑一轮。
   */
  async *resumeStream(
    threadId: ThreadId,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    yield* this.runGraphStream(threadId, { messages: [] }, signal);
  }

  /**
   * 执行 graph.stream 并把 AIMessageChunk 逐个 yield 成 StreamChunk；末尾 yield
   * usage 事件。
   *
   * 控制台打四个时间锚点（设 `MESHBOT_GRAPH_TIMING=0` 关闭）便于拆解延迟：
   *  - stream-init：graph.stream() 同步开销（图构建 / 凭证加载）
   *  - first-chunk：首个 AIMessageChunk 到达 = LLM TTFT（time-to-first-token）
   *  - last-chunk：末个 chunk 到达 = LLM 总产出时间
   *  - stream-close：异步迭代器关闭 = 流读取额外延迟
   */
  private async *runGraphStream(
    threadId: ThreadId,
    input: { messages: BaseMessage[] },
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const timing = process.env.MESHBOT_GRAPH_TIMING !== "0";
    const startedAt = Date.now();
    const stream = await this.graph.stream(input, {
      configurable: { thread_id: threadId },
      streamMode: "messages",
      signal,
    });
    const initMs = Date.now() - startedAt;
    if (timing) {
      console.log(`[graph timing] thread=${threadId} stream-init=${initMs}ms`);
    }
    let lastMessageId: string | null = null;
    let accumulated: AIMessageChunk | undefined;
    let firstChunkAt = 0;
    let firstReasoningAt = 0;
    let lastChunkAt = 0;
    let chunkCount = 0;
    let reasoningCount = 0;
    for await (const part of stream) {
      // streamMode:"messages" 产出 [BaseMessage, metadata] 元组
      const msg = Array.isArray(part) ? part[0] : part;
      if (!(msg instanceof AIMessageChunk)) continue;
      accumulated = accumulated === undefined ? msg : accumulated.concat(msg);
      const messageId = msg.id ?? randomUUID();
      lastMessageId = messageId;
      // DeepSeek 等推理模型先吐 reasoning_content（额外字段），再吐 content。
      // 同一个 chunk 不会同时有两者，分别处理。
      const reasoningDelta =
        typeof msg.additional_kwargs?.reasoning_content === "string"
          ? msg.additional_kwargs.reasoning_content
          : "";
      if (reasoningDelta) {
        if (firstReasoningAt === 0) {
          firstReasoningAt = Date.now();
          if (timing) {
            console.log(
              `[graph timing] thread=${threadId} first-reasoning=${firstReasoningAt - startedAt}ms`,
            );
          }
        }
        reasoningCount += 1;
        yield { kind: "reasoning", messageId, delta: reasoningDelta };
      }
      const delta = typeof msg.content === "string" ? msg.content : "";
      if (!delta) continue;
      if (firstChunkAt === 0) {
        firstChunkAt = Date.now();
        if (timing) {
          console.log(
            `[graph timing] thread=${threadId} first-chunk=${firstChunkAt - startedAt}ms (TTFT after stream-init: ${firstChunkAt - startedAt - initMs}ms)`,
          );
        }
      }
      lastChunkAt = Date.now();
      chunkCount += 1;
      yield { kind: "chunk", messageId, delta };
    }
    const streamClosedAt = Date.now();
    if (timing) {
      const lastChunkOffset = lastChunkAt ? lastChunkAt - startedAt : -1;
      const closeAfterLastChunk = lastChunkAt
        ? streamClosedAt - lastChunkAt
        : -1;
      console.log(
        `[graph timing] thread=${threadId} reasoning=${reasoningCount} chunks=${chunkCount} last-chunk=${lastChunkOffset}ms stream-close=${streamClosedAt - startedAt}ms (after-last-chunk=${closeAfterLastChunk}ms)`,
      );
    }
    // 流结束：先取 LangChain 标准 usage_metadata，缺失则按多个兜底字段（OpenAI 兼容
    // 路径如 deepseek-v4-pro 把 token 信息放 response_metadata.usage / tokenUsage）提取。
    const extracted = extractUsage(accumulated);
    if (extracted && lastMessageId) {
      yield {
        kind: "usage",
        messageId: lastMessageId,
        providerType: this.modelMeta.providerType,
        model: this.modelMeta.model,
        inputTokens: extracted.inputTokens,
        outputTokens: extracted.outputTokens,
        totalTokens: extracted.totalTokens,
        cacheReadTokens: extracted.cacheReadTokens,
        cacheCreationTokens: extracted.cacheCreationTokens,
        reasoningTokens: extracted.reasoningTokens,
        durationMs: Date.now() - startedAt,
      };
    } else if (lastMessageId) {
      console.warn(
        `LLM provider ${this.modelMeta.providerType} (${this.modelMeta.model}) 未上报 usage（usage_metadata / response_metadata.usage / additional_kwargs.usage 均缺失）, thread=${threadId}`,
      );
    }
  }

  /**
   * 取会话已处理消息历史（来自 checkpointer）。
   *
   * 过滤掉无可显示文本的消息（例如 tool_call-only 的 AIMessage、
   * 中断/失败留下的空 AIMessage），避免前端渲染空气泡。
   * 缺 id 的也跳过（不再用 randomUUID 兜底，因为每次刷新会变 → 前端按 id 去重失效）。
   */
  async getHistory(threadId: ThreadId): Promise<Message[]> {
    const snapshot = await this.graph.getState({
      configurable: { thread_id: threadId },
    });
    const values = snapshot.values as GraphState;
    if (!values?.messages) return [];
    const result: Message[] = [];
    for (const m of values.messages) {
      if (!m.id) continue;
      const content = typeof m.content === "string" ? m.content : "";
      if (!content) continue;
      const reasoning =
        typeof m.additional_kwargs?.reasoning_content === "string"
          ? m.additional_kwargs.reasoning_content
          : undefined;
      result.push({
        id: m.id,
        role: this.roleOf(m),
        content,
        ...(reasoning ? { reasoning } : {}),
      });
    }
    return result;
  }

  private roleOf(m: BaseMessage): "user" | "assistant" | "system" {
    const t = m._getType();
    if (t === "human") return "user";
    if (t === "system") return "system";
    return "assistant";
  }
}

/** 从累计 AIMessageChunk 提取规范化 token 用量。 */
interface ExtractedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
}

/**
 * 从累计 AIMessageChunk 兜底提取 token 用量。
 *
 * 取数优先级：
 * 1. `usage_metadata` —— LangChain 0.3 跨厂商标准字段（@langchain/openai 0.6+ 等）
 * 2. `response_metadata.usage` —— OpenAI 兼容路径原始字段（deepseek、第三方代理常用）
 * 3. `response_metadata.tokenUsage` —— LangChain 旧版 camelCase 字段
 * 4. `additional_kwargs.usage` —— 个别集成包的位置
 *
 * 全部缺失返回 null。
 */
function extractUsage(msg: AIMessageChunk | undefined): ExtractedUsage | null {
  if (!msg) return null;

  // 1) LangChain 标准 usage_metadata
  const meta = msg.usage_metadata;
  if (meta && (meta.input_tokens || meta.output_tokens || meta.total_tokens)) {
    return {
      inputTokens: meta.input_tokens ?? 0,
      outputTokens: meta.output_tokens ?? 0,
      totalTokens: meta.total_tokens ?? 0,
      cacheReadTokens: meta.input_token_details?.cache_read ?? 0,
      cacheCreationTokens: meta.input_token_details?.cache_creation ?? 0,
      reasoningTokens: meta.output_token_details?.reasoning ?? 0,
    };
  }

  const rawMsg = msg as unknown as {
    response_metadata?: Record<string, unknown>;
    additional_kwargs?: Record<string, unknown>;
  };

  // 2) response_metadata.usage —— OpenAI 兼容字段（snake_case）
  const respUsage = rawMsg.response_metadata?.usage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
        // deepseek 私有扩展
        prompt_cache_hit_tokens?: number;
      }
    | undefined;
  if (
    respUsage &&
    (respUsage.prompt_tokens ||
      respUsage.completion_tokens ||
      respUsage.total_tokens)
  ) {
    const inputTokens = respUsage.prompt_tokens ?? 0;
    const outputTokens = respUsage.completion_tokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: respUsage.total_tokens ?? inputTokens + outputTokens,
      cacheReadTokens:
        respUsage.prompt_tokens_details?.cached_tokens ??
        respUsage.prompt_cache_hit_tokens ??
        0,
      cacheCreationTokens: 0,
      reasoningTokens:
        respUsage.completion_tokens_details?.reasoning_tokens ?? 0,
    };
  }

  // 3) response_metadata.tokenUsage —— LangChain 旧式 camelCase
  const tokenUsage = rawMsg.response_metadata?.tokenUsage as
    | {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
      }
    | undefined;
  if (tokenUsage && (tokenUsage.promptTokens || tokenUsage.completionTokens)) {
    const inputTokens = tokenUsage.promptTokens ?? 0;
    const outputTokens = tokenUsage.completionTokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: tokenUsage.totalTokens ?? inputTokens + outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    };
  }

  // 4) additional_kwargs.usage
  const altUsage = rawMsg.additional_kwargs?.usage as
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      }
    | undefined;
  if (altUsage && (altUsage.prompt_tokens || altUsage.completion_tokens)) {
    const inputTokens = altUsage.prompt_tokens ?? 0;
    const outputTokens = altUsage.completion_tokens ?? 0;
    return {
      inputTokens,
      outputTokens,
      totalTokens: altUsage.total_tokens ?? inputTokens + outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    };
  }

  return null;
}
