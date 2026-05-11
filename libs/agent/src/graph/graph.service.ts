import { randomUUID } from "node:crypto";
import type { BaseMessage } from "@langchain/core/messages";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { CompiledStateGraph } from "@langchain/langgraph";
import type { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { Injectable } from "@nestjs/common";
import { createSqliteCheckpointer } from "../checkpoint/sqlite-checkpointer";
import type { MeshbotConfigService } from "../config/meshbot-config.service";
import type { PromptService } from "../prompt/prompt.service";
import type { GraphState } from "./graph.builder";
import { buildSupervisorGraph } from "./graph.builder";

export interface AgentConfig {
  model: string;
  temperature?: number;
  systemPrompt?: string;
  tools?: string[];
}

export interface AgentResponse {
  content: string;
  threadId: string;
  checkpointId: string;
}

export type ThreadId = string;

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

@Injectable()
export class GraphService {
  private checkpointer: SqliteSaver;
  private graph: CompiledStateGraph<
    typeof import("./graph.builder").StateAnnotation.State,
    Partial<typeof import("./graph.builder").StateAnnotation.State>,
    "supervisor" | "__start__",
    Record<string, unknown>,
    typeof import("./graph.builder").StateAnnotation.State,
    typeof import("./graph.builder").StateAnnotation.State
  >;

  constructor(
    private configService: MeshbotConfigService,
    private promptService: PromptService,
  ) {
    const dbPath = this.configService.getDatabasePath();
    this.checkpointer = createSqliteCheckpointer(dbPath);
    this.graph = buildSupervisorGraph(this.checkpointer);
  }

  async startSession(config: AgentConfig): Promise<ThreadId> {
    const threadId = randomUUID();
    const systemPrompt =
      config.systemPrompt ?? this.promptService.getPrompt("system");
    if (systemPrompt) {
      await this.graph.invoke(
        { messages: [new SystemMessage(systemPrompt)] },
        { configurable: { thread_id: threadId } },
      );
    }
    return threadId;
  }

  async sendMessage(
    threadId: ThreadId,
    message: string,
  ): Promise<AgentResponse> {
    this.promptService.reloadIfChanged();

    const result = await this.graph.invoke(
      { messages: [new HumanMessage(message)] },
      { configurable: { thread_id: threadId } },
    );

    const msgs = (result as GraphState).messages;
    const lastMessage = msgs[msgs.length - 1];
    return {
      content:
        typeof lastMessage?.content === "string" ? lastMessage.content : "",
      threadId,
      checkpointId: "",
    };
  }

  async getHistory(threadId: ThreadId): Promise<Message[]> {
    const snapshot = await this.graph.getState({
      configurable: { thread_id: threadId },
    });
    const values = snapshot.values as GraphState;
    if (!values?.messages) return [];
    return values.messages.map((msg: BaseMessage) => ({
      role: msg._getType() as "user" | "assistant" | "system",
      content: typeof msg.content === "string" ? msg.content : "",
      timestamp: new Date(),
    }));
  }
}
