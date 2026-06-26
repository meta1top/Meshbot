import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { Injectable } from "@nestjs/common";
export { buildSkillsBlock } from "./context-builder";
import { ModelResolver } from "./model-resolver.service";
import { ThreadStateService } from "./thread-state.service";
import { GraphRunner } from "./graph-runner.service";
import type {
  AgentConfig,
  Message,
  StreamChunk,
  ThreadId,
} from "./graph.types";

@Injectable()
export class GraphService {
  constructor(
    private readonly modelResolver: ModelResolver,
    private readonly threadState: ThreadStateService,
    private readonly graphRunner: GraphRunner,
  ) {}

  /** 委派给 GraphRunner：创建会话，返回 thread id。 */
  async startSession(_config: AgentConfig): Promise<ThreadId> {
    return this.graphRunner.startSession(_config);
  }

  /**
   * 委派给 GraphRunner：向会话发送一批消息并逐 token 流式产出 assistant 回复。
   */
  async *streamMessage(
    threadId: ThreadId,
    inputs: { id: string; content: string }[],
    signal?: AbortSignal,
    kind?: string,
  ): AsyncGenerator<StreamChunk> {
    yield* this.graphRunner.streamMessage(threadId, inputs, signal, kind);
  }

  /** 委派给 GraphRunner：从 checkpointer 现有状态恢复并流式产出 assistant 回复。 */
  async *resumeStream(
    threadId: ThreadId,
    signal?: AbortSignal,
    kind?: string,
  ): AsyncGenerator<StreamChunk> {
    yield* this.graphRunner.resumeStream(threadId, signal, kind);
  }

  /** 委派给 ThreadStateService：删除 thread 的 checkpoints/writes 行。 */
  clearThread(threadId: string): void {
    this.threadState.clearThread(threadId);
  }

  /** 委派给 ThreadStateService：剪掉末尾孤儿 tool_calls AIMessage。 */
  async cutMessagesAfter(
    threadId: ThreadId,
    cutoffMessageId: string,
  ): Promise<void> {
    return this.threadState.cutMessagesAfter(threadId, cutoffMessageId);
  }

  /** 委派给 ThreadStateService：返回当前 thread 的 messages 快照。 */
  async getMessagesSnapshot(threadId: ThreadId): Promise<BaseMessage[]> {
    return this.threadState.getMessagesSnapshot(threadId);
  }

  /** 委派给 ThreadStateService：返回会话消息历史。 */
  async getHistory(threadId: ThreadId): Promise<Message[]> {
    return this.threadState.getHistory(threadId);
  }

  /** 委派给 ThreadStateService：重排压缩结果写入 checkpointer。 */
  async applyCompaction(
    threadId: ThreadId,
    params: {
      removeIds: string[];
      summaryText: string;
      keep: BaseMessage[];
    },
  ): Promise<void> {
    return this.threadState.applyCompaction(threadId, params);
  }

  /**
   * 给 SessionTitleService 用的标题模型：委派给 ModelResolver。
   */
  async getTitleModel(): Promise<BaseChatModel> {
    return this.modelResolver.getTitleModel();
  }

  /**
   * 调摘要 LLM：委派给 ModelResolver。
   */
  async summarize(
    serialized: string,
    opts: { systemPrompt: string; timeoutMs: number; maxTokens: number },
  ): Promise<string> {
    return this.modelResolver.summarize(serialized, opts);
  }

  /** 委派给 ModelResolver：解析当前配置的模型实例。 */
  private async resolveModel(): Promise<BaseChatModel> {
    return this.modelResolver.resolveModel();
  }
}
