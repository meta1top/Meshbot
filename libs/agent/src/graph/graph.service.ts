import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import {
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { Injectable, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { createSqliteCheckpointer } from "../checkpoint/sqlite-checkpointer";
import { MeshbotConfigService } from "../config/meshbot-config.service";
import { readActiveModelConfig } from "../config/model-config.reader";
import { PromptService } from "../prompt/prompt.service";
import { ToolRegistry } from "../tools/tool-registry";
import type { ToolContext } from "../tools/tool.types";
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
 * - tool_calls：LLM 本轮调用的全部工具调用（本轮 LLM 结束、tools 节点开跑前 yield）；
 * - assistant_done：本轮 LLM 完整结束（finish=stop 或 finish=tool_calls）。runner 据此
 *   持久化一条 session_messages.assistant；ReAct 多轮里会 emit 多次（每轮一次）。
 *   usage 跟随同一轮的 assistant_done 之后立即 yield。
 * - usage：调用结束的 token 用量。
 */
export type StreamChunk =
  | { kind: "human"; messageId: string }
  | { kind: "reasoning"; messageId: string; delta: string }
  | { kind: "chunk"; messageId: string; delta: string }
  | {
      kind: "tool_calls";
      messageId: string;
      /** LangChain AIMessage.tool_calls 原始数组（含 id/name/args）。 */
      toolCalls: unknown[];
    }
  | {
      kind: "assistant_done";
      messageId: string;
      content: string;
      reasoning: string;
      toolCalls: unknown[] | null;
    }
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
  /**
   * 当前活跃模型的 provider/model meta，用于 usage 事件标注。
   *
   * 当前实现：单例字段，resolveModel() 时刷新。本地轨同一时刻只有一个 enabled
   * model（model_configs 唯一启用），并发 run 拿到的 modelMeta 相同 → 安全。
   * 未来支持多模型并发时，要么挪进 runCtx，要么 inline 到 usage emit。
   */
  private modelMeta: { providerType: string; model: string };
  /**
   * 缓存 chat model 实例。key 由 provider/model/baseUrl/apiKey 拼成，配置变化
   * 自动 miss。避免每次 runOnce 都 initChatModel 动态加载包（~200ms / 次）。
   */
  private modelCache = new Map<string, BaseChatModel>();
  /**
   * 每个并发 run 的上下文。用 AsyncLocalStorage 把 ctx 绑到调用栈，让多个
   * session 同时跑时各自的 toolsNode getCtx() 拿到的是本 run 的 ctx，不会串。
   * 之前用单例 ctxRef 字段，后开的 run 会覆盖前一个 → tools 路由错误 / 事件
   * emit 到错 session。
   *
   * messageId 是 mutable 的（每轮 LLM 切换时 runGraphStream 内更新），所以
   * 包了一层对象 ref，让 toolsNode 总能拿到最新值。
   */
  private readonly runCtx = new AsyncLocalStorage<{
    sessionId: string;
    messageId: string;
    signal: AbortSignal;
  }>();

  constructor(
    private configService: MeshbotConfigService,
    private promptService: PromptService,
    private readonly toolRegistry: ToolRegistry,
    private readonly eventEmitter: EventEmitter2,
    @Optional() modelProvider?: ModelProvider,
    @Optional() modelMeta?: { providerType: string; model: string },
  ) {
    const dbPath = this.configService.getDatabasePath();
    this.checkpointer = createSqliteCheckpointer(dbPath);
    const provider: ModelProvider =
      modelProvider ?? (() => this.resolveModel());
    this.graph = buildSupervisorGraph(
      this.checkpointer,
      provider,
      this.toolRegistry,
      () => {
        const ctx = this.runCtx.getStore();
        if (!ctx) {
          throw new Error(
            "toolsNode called without active run (AsyncLocalStorage 未绑定 ctx)",
          );
        }
        return {
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
          emitter: this.eventEmitter,
          signal: ctx.signal,
        } satisfies Omit<ToolContext, "toolCallId">;
      },
    );
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
   * 暴露给 SessionTitleService 等非 graph 流程使用同一 chat model（带 cache）。
   * 共享 modelCache 避免 SessionTitleService 每次都 initChatModel（~200ms）。
   */
  async getModel(): Promise<BaseChatModel> {
    return this.resolveModel();
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
    const abortSignal = signal ?? new AbortController().signal;
    const ctx = { sessionId: threadId, messageId: "", signal: abortSignal };
    // ALS.run 包整个 generator —— toolsNode getCtx() / runGraphStream 内
    // 更新 messageId 都走同一份 ctx 引用。多 session 并发互不干扰。
    yield* this.runCtx.run(ctx, () =>
      this.streamMessageImpl(threadId, inputs, signal),
    );
  }

  private async *streamMessageImpl(
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
    const abortSignal = signal ?? new AbortController().signal;
    const ctx = { sessionId: threadId, messageId: "", signal: abortSignal };
    yield* this.runCtx.run(ctx, () =>
      this.runGraphStream(threadId, { messages: [] }, signal),
    );
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
    // 每轮 LLM 单独累加：同一轮 chunk 共享 msg.id；msg.id 变化即轮次切换 → flush 上一轮。
    // 这样 ReAct 多轮里每轮独立 emit assistant_done + usage，runner 按轮写
    // session_messages，避免不同轮 reasoning 被合并到同一条 assistant。
    let currentId: string | null = null;
    let currentAcc: AIMessageChunk | undefined;
    let currentRoundStartedAt = startedAt;
    let firstChunkAt = 0;
    let firstReasoningAt = 0;
    let lastChunkAt = 0;
    let chunkCount = 0;
    let reasoningCount = 0;
    const flushRound = function* (this: GraphService): Generator<StreamChunk> {
      if (currentId === null || currentAcc === undefined) return;
      const content =
        typeof currentAcc.content === "string" ? currentAcc.content : "";
      const reasoning =
        typeof currentAcc.additional_kwargs?.reasoning_content === "string"
          ? currentAcc.additional_kwargs.reasoning_content
          : "";
      const toolCalls = currentAcc.tool_calls ?? [];
      if (toolCalls.length > 0) {
        yield {
          kind: "tool_calls",
          messageId: currentId,
          toolCalls,
        };
      }
      yield {
        kind: "assistant_done",
        messageId: currentId,
        content,
        reasoning,
        toolCalls: toolCalls.length > 0 ? toolCalls : null,
      };
      const extracted = extractUsage(currentAcc);
      if (extracted) {
        yield {
          kind: "usage",
          messageId: currentId,
          providerType: this.modelMeta.providerType,
          model: this.modelMeta.model,
          inputTokens: extracted.inputTokens,
          outputTokens: extracted.outputTokens,
          totalTokens: extracted.totalTokens,
          cacheReadTokens: extracted.cacheReadTokens,
          cacheCreationTokens: extracted.cacheCreationTokens,
          reasoningTokens: extracted.reasoningTokens,
          durationMs: Date.now() - currentRoundStartedAt,
        };
      } else {
        console.warn(
          `LLM provider ${this.modelMeta.providerType} (${this.modelMeta.model}) 未上报 usage（usage_metadata / response_metadata.usage / additional_kwargs.usage 均缺失）, thread=${threadId} msg=${currentId}`,
        );
      }
    }.bind(this);

    for await (const part of stream) {
      // streamMode:"messages" 产出 [BaseMessage, metadata] 元组
      const msg = Array.isArray(part) ? part[0] : part;
      if (!(msg instanceof AIMessageChunk)) continue;
      const messageId = msg.id ?? randomUUID();
      // 轮次切换：flush 上一轮，重置累加
      if (currentId !== null && currentId !== messageId) {
        yield* flushRound();
        currentAcc = undefined;
        currentRoundStartedAt = Date.now();
      }
      currentId = messageId;
      currentAcc = currentAcc === undefined ? msg : currentAcc.concat(msg);
      const ctx = this.runCtx.getStore();
      if (ctx) ctx.messageId = messageId;
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
    // 流结束：flush 最后一轮
    yield* flushRound();
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
