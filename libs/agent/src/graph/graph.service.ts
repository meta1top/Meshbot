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
}

/** 流式 run 产出的单个 token 事件。 */
export interface StreamChunk {
  messageId: string;
  delta: string;
}

@Injectable()
export class GraphService {
  private checkpointer: ReturnType<typeof createSqliteCheckpointer>;
  private graph: ReturnType<typeof buildSupervisorGraph>;

  constructor(
    private configService: MeshbotConfigService,
    private promptService: PromptService,
    @Optional() modelProvider?: ModelProvider,
  ) {
    const dbPath = this.configService.getDatabasePath();
    this.checkpointer = createSqliteCheckpointer(dbPath);
    const provider: ModelProvider =
      modelProvider ?? (() => this.resolveModel());
    this.graph = buildSupervisorGraph(this.checkpointer, provider);
  }

  /** 按当前 agent.db 的启用 ModelConfig 构造 chat model。 */
  private async resolveModel(): Promise<BaseChatModel> {
    const cfg = readActiveModelConfig(this.configService.getDatabasePath());
    if (!cfg) {
      throw new Error(
        "没有启用的模型配置（model_configs 表为空或全部 disabled）",
      );
    }
    return createChatModel(cfg);
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
    this.promptService.reloadIfChanged();
    yield* this.runGraphStream(threadId, { messages: [] }, signal);
  }

  /** 执行 graph.stream 并把 AIMessageChunk 逐个 yield 成 StreamChunk。 */
  private async *runGraphStream(
    threadId: ThreadId,
    input: { messages: BaseMessage[] } | null,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    const stream = await this.graph.stream(input, {
      configurable: { thread_id: threadId },
      streamMode: "messages",
      signal,
    });
    for await (const part of stream) {
      // streamMode:"messages" 产出 [BaseMessage, metadata] 元组
      const msg = Array.isArray(part) ? part[0] : part;
      if (!(msg instanceof AIMessageChunk)) continue;
      const delta = typeof msg.content === "string" ? msg.content : "";
      if (!delta) continue;
      yield { messageId: msg.id ?? randomUUID(), delta };
    }
  }

  /** 取会话已处理消息历史（来自 checkpointer）。 */
  async getHistory(threadId: ThreadId): Promise<Message[]> {
    const snapshot = await this.graph.getState({
      configurable: { thread_id: threadId },
    });
    const values = snapshot.values as GraphState;
    if (!values?.messages) return [];
    return values.messages.map((m: BaseMessage) => ({
      id: m.id ?? randomUUID(),
      role: this.roleOf(m),
      content: typeof m.content === "string" ? m.content : "",
    }));
  }

  private roleOf(m: BaseMessage): "user" | "assistant" | "system" {
    const t = m._getType();
    if (t === "human") return "user";
    if (t === "system") return "system";
    return "assistant";
  }
}
