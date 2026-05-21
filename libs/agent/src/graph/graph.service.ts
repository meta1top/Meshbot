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
   * config 暂未使用，保留入参便于后续接入 temperature / model。
   */
  async startSession(_config: AgentConfig): Promise<ThreadId> {
    const threadId = randomUUID();
    return threadId;
  }

  /**
   * 向会话发送一条消息并逐 token 流式产出 assistant 回复。
   *
   * 基于 LangGraph graph.stream(..., { streamMode: "messages" })：
   * 每个 chunk 带稳定 message.id，作为本条 assistant 消息的标识。
   * 透传 signal 支持中断。
   */
  async *streamMessage(
    threadId: ThreadId,
    message: string,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamChunk> {
    this.promptService.reloadIfChanged();
    const systemPrompt = this.promptService.getPrompt("system");
    const inputMessages: BaseMessage[] = [];
    if (systemPrompt) {
      inputMessages.push(new SystemMessage(systemPrompt));
    }
    inputMessages.push(new HumanMessage(message));
    const stream = await this.graph.stream(
      { messages: inputMessages },
      {
        configurable: { thread_id: threadId },
        streamMode: "messages",
        signal,
      },
    );
    for await (const part of stream) {
      const msg = Array.isArray(part) ? part[0] : part;
      if (!(msg instanceof AIMessageChunk)) continue;
      const delta = typeof msg.content === "string" ? msg.content : "";
      if (!delta) continue;
      yield { messageId: msg.id ?? threadId, delta };
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
