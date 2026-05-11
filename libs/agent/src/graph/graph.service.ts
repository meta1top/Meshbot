import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { createSqliteCheckpointer } from "../checkpoint/sqlite-checkpointer";
import type { MeshbotConfigService } from "../config/meshbot-config.service";
import type { PromptService } from "../prompt/prompt.service";
import { buildSupervisorGraph } from "./graph.builder";

export type ThreadId = string;

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: Date;
}

export interface AgentConfig {
  model?: string;
  systemPrompt?: string;
}

export interface AgentResponse {
  content: string;
  threadId: ThreadId;
  checkpointId: string;
}

@Injectable()
export class GraphService {
  private checkpointer: ReturnType<typeof createSqliteCheckpointer>;
  private graph: ReturnType<typeof buildSupervisorGraph>;

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
        { messages: [{ role: "system", content: systemPrompt }] },
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
      { messages: [{ role: "user", content: message }] },
      { configurable: { thread_id: threadId } },
    );

    const lastMessage = result.messages[result.messages.length - 1];
    return {
      content: lastMessage?.content ?? "",
      threadId,
      checkpointId: "",
    };
  }

  async getHistory(threadId: ThreadId): Promise<Message[]> {
    const state = await this.graph.getState({
      configurable: { thread_id: threadId },
    });
    return state.messages.map((msg: any) => ({
      role: msg.role as "user" | "assistant" | "system",
      content: msg.content,
      timestamp: new Date(),
    }));
  }
}
