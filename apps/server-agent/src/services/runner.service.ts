import { GraphService } from "@meshbot/agent";
import {
  type RunToolCallEndEvent,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { LlmCallService } from "./llm-call.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";

/** 进程内 run 的内存状态。 */
interface InflightRun {
  /** 当前轮 assistant 的 messageId（流式过程中切轮就替换）。 */
  messageId: string | null;
  /** 当前轮 assistant 累加的 content（chunk 阶段 += delta；切轮清空）。 */
  content: string;
  /** 当前轮累加的 reasoning（reasoning 事件 += delta；切轮清空）。 */
  reasoning: string;
  status: "streaming" | "done" | "interrupted";
  abort: AbortController;
}

/** getInflight 对外快照（subscribe replay 用）。 */
export interface InflightView {
  messageId: string | null;
  content: string;
  reasoning: string;
  status: "streaming" | "done" | "interrupted";
}

/**
 * Agent run 执行器：进程内单例，维护内存 inflight 并驱动流式 run。
 *
 * 一个 session 同一时刻最多一个 inflight。run 结束自动检查是否还有 pending
 * 消息，有则续跑（消费循环），直到队空。
 */
@Injectable()
export class RunnerService implements OnModuleInit {
  private readonly logger = new Logger(RunnerService.name);
  private readonly inflight = new Map<string, InflightRun>();
  /** 消费循环入口哨兵：在第一个 await 之前同步设置，防止同一 tick 双 kick。 */
  private readonly running = new Set<string>();

  constructor(
    private readonly sessions: SessionService,
    private readonly graph: GraphService,
    private readonly emitter: EventEmitter2,
    private readonly llmCalls: LlmCallService,
    private readonly sessionMessages: SessionMessageService,
  ) {}

  /** 启动时把遗留的 processing 消息退回 pending（重启 inflight 丢失后可重跑）。 */
  async onModuleInit(): Promise<void> {
    // 本地轨单进程单用户：重启时全量回滚遗留 processing（无需按 session 过滤）
    const n = await this.sessions.rollbackProcessingToPending();
    if (n > 0) {
      this.logger.log(`启动恢复：${n} 条遗留 processing 消息已退回 pending`);
    }
  }

  /** 启动消费循环（fire-and-forget）。已有消费循环则跳过（防重入）。 */
  kick(sessionId: string): void {
    if (this.running.has(sessionId)) return;
    void this.kickAndWait(sessionId).catch((err) => {
      this.logger.error(`run loop crashed for ${sessionId}`, err);
    });
  }

  /** 启动重试消费（fire-and-forget）。重试 failed 消息。 */
  kickRetry(sessionId: string): void {
    if (this.running.has(sessionId)) return;
    void this.kickRetryAndWait(sessionId).catch((err) => {
      this.logger.error(`retry loop crashed for ${sessionId}`, err);
    });
  }

  /**
   * 取某 session 当前 inflight 快照；无则 null。
   *
   * 只暴露真正「在跑」的 run（status === streaming）。run 完成后
   * inflight 条目仍会在 finally 块里短暂存留，期间 frontend 若刚好
   * fetchHistory 会拿到 done 状态的残影，与 checkpointer 里持久化好的
   * assistant 消息形成「双气泡」（一个完整、一个空带闪烁光标）。
   */
  getInflight(sessionId: string): InflightView | null {
    const run = this.inflight.get(sessionId);
    if (!run || run.status !== "streaming") return null;
    return {
      messageId: run.messageId,
      content: run.content,
      reasoning: run.reasoning,
      status: run.status,
    };
  }

  /** 中断某 session 当前 run。 */
  interrupt(sessionId: string): void {
    this.inflight.get(sessionId)?.abort.abort();
  }

  /**
   * 消费循环：取 pending → 跑一次 run → 检查是否还有 pending → 续跑。
   * 测试直接 await 本方法；生产经 kick 触发不 await。
   *
   * running 哨兵在第一个 await 之前同步设置，防止同 tick 内双 kick 竞争。
   * runOnce 抛错时由内层 try/catch 记录日志后中断循环（避免毒消息无限重试），
   * 错误事件已在 runOnce 内发出，本方法对外正常 resolve。
   */
  async kickAndWait(sessionId: string): Promise<void> {
    if (this.running.has(sessionId)) return;
    this.running.add(sessionId);
    await this.sessions.setStatus(sessionId, "running");
    try {
      while (true) {
        const batch = await this.sessions.claimPending(sessionId);
        if (batch.length === 0) break;
        try {
          await this.runOnce(sessionId, batch, false);
        } catch (err) {
          this.logger.warn(`runOnce 失败，停止消费循环：${sessionId}`, err);
          break;
        }
      }
    } finally {
      this.running.delete(sessionId);
      await this.sessions.setStatus(sessionId, "idle");
    }
  }

  /**
   * 重试消费循环：取 failed 消息 → resume run（不写新 HumanMessage）→
   * 检查是否还有 failed → 续跑。测试直接 await 本方法；生产经 kickRetry 触发不 await。
   *
   * 结构与 kickAndWait 一致：running 哨兵防双 kick，runOnce 抛错时记录日志后中断循环。
   */
  async kickRetryAndWait(sessionId: string): Promise<void> {
    if (this.running.has(sessionId)) return;
    this.running.add(sessionId);
    await this.sessions.setStatus(sessionId, "running");
    try {
      while (true) {
        const batch = await this.sessions.claimFailed(sessionId);
        if (batch.length === 0) break;
        try {
          await this.runOnce(sessionId, batch, true);
        } catch (err) {
          this.logger.warn(`retry runOnce 失败：${sessionId}`, err);
          break;
        }
      }
    } finally {
      this.running.delete(sessionId);
      await this.sessions.setStatus(sessionId, "idle");
    }
  }

  /**
   * 触发 resume：不 claim pending_messages，直接走 resumeStream（checkpointer
   * 现有 state 重新跑一轮）。供「重生成」用 —— 该 user 消息已是 checkpointer
   * 最后一条，resume 会从该点重新调 LLM。
   *
   * running 哨兵防双 kick。runOnce 抛错时记录日志后退出，不无限循环。
   */
  kickResume(sessionId: string): void {
    if (this.running.has(sessionId)) return;
    void this.kickResumeAndWait(sessionId).catch((err) => {
      this.logger.error(`resume loop crashed for ${sessionId}`, err);
    });
  }

  async kickResumeAndWait(sessionId: string): Promise<void> {
    if (this.running.has(sessionId)) return;
    this.running.add(sessionId);
    await this.sessions.setStatus(sessionId, "running");
    try {
      await this.runOnce(sessionId, [], true);
    } catch (err) {
      this.logger.warn(`resume runOnce 失败：${sessionId}`, err);
    } finally {
      this.running.delete(sessionId);
      await this.sessions.setStatus(sessionId, "idle");
    }
  }

  /**
   * 跑一次 run —— 流式产出一批消息的应答；逐 chunk 发 runChunk；
   * 完成发 runDone 并 markProcessed；被中断发 runInterrupted；
   * 其他错误把消息标 failed（HumanMessage 已在 checkpointer，不回滚 pending）、
   * 发 runError 并向上抛（由消费循环捕获以中止，避免毒消息无限重试）。
   *
   * resume=false 走 streamMessage（按 batch 逐条写带 id 的 HumanMessage）；
   * resume=true 走 resumeStream（从 checkpointer 现有状态重跑，不写新消息）。
   */
  private async runOnce(
    sessionId: string,
    batch: { id: string; content: string }[],
    resume: boolean,
  ): Promise<void> {
    const ids = batch.map((m) => m.id);
    const run: InflightRun = {
      messageId: null,
      content: "",
      reasoning: "",
      status: "streaming",
      abort: new AbortController(),
    };
    this.inflight.set(sessionId, run);
    const runStartedAt = Date.now();
    this.logger.log(
      `runOnce start session=${sessionId} batch=${ids.length} resume=${resume}`,
    );
    let firstHumanLogged = false;
    let firstChunkLogged = false;
    try {
      const stream = resume
        ? this.graph.resumeStream(sessionId, run.abort.signal)
        : this.graph.streamMessage(sessionId, batch, run.abort.signal);
      for await (const event of stream) {
        if (event.kind === "human") {
          if (!firstHumanLogged) {
            firstHumanLogged = true;
            this.logger.log(
              `runOnce first-human session=${sessionId} +${Date.now() - runStartedAt}ms`,
            );
          }
          this.emitter.emit(SESSION_WS_EVENTS.runHuman, {
            sessionId,
            messageId: event.messageId,
          });
          // 双写 session_messages（fire-and-forget，写失败仅 log）
          const content =
            batch.find((b) => b.id === event.messageId)?.content ?? "";
          this.sessionMessages
            .recordUser({ id: event.messageId, sessionId, content })
            .catch((err) =>
              this.logger.error(
                `session_messages.recordUser 失败 msg=${event.messageId}`,
                err,
              ),
            );
          continue;
        }
        if (event.kind === "reasoning") {
          // 同步更新 inflight reasoning 快照，让 subscribe 中途接入也能 replay
          // 已收到的思考内容（多轮 ReAct 切轮时 messageId 变化会清空旧 reasoning）。
          if (run.messageId !== event.messageId) {
            run.messageId = event.messageId;
            run.content = "";
            run.reasoning = "";
          }
          run.reasoning += event.delta;
          this.emitter.emit(SESSION_WS_EVENTS.runReasoning, {
            sessionId,
            messageId: event.messageId,
            delta: event.delta,
          });
          continue;
        }
        if (event.kind === "tool_calls") {
          // tool_calls 在 assistant_done 里一并带过来，这里不需要单独处理
          continue;
        }
        if (event.kind === "chunk") {
          if (!firstChunkLogged) {
            firstChunkLogged = true;
            this.logger.log(
              `runOnce first-chunk session=${sessionId} +${Date.now() - runStartedAt}ms (LLM TTFT incl graph init)`,
            );
          }
          // 在 chunk 阶段同步更新 inflight 快照（messageId 首次出现时设、content
          // 累加），让 ws 订阅 handleSubscribe 的 replay 能在流式中途也拼出已收
          // 到的部分。否则 inflight.messageId 要等到 assistant_done 才有，订阅时
          // 「之前的输出」都看不到。轮切换时一并清 reasoning，避免上一轮 reasoning
          // 残留（与 reasoning handler 同款逻辑）。
          if (run.messageId !== event.messageId) {
            run.messageId = event.messageId;
            run.content = "";
            run.reasoning = "";
          }
          run.content += event.delta;
          this.emitter.emit(SESSION_WS_EVENTS.runChunk, {
            sessionId,
            messageId: event.messageId,
            delta: event.delta,
          });
          continue;
        }
        if (event.kind === "assistant_done") {
          // 每轮 LLM 结束：立刻持久化一条 session_messages.assistant。
          // ReAct 多轮里会触发多次，每条独立 messageId / reasoning / toolCalls。
          run.messageId = event.messageId;
          run.content = event.content;
          const reasoning = event.reasoning ? event.reasoning : null;
          const toolCallsJson = event.toolCalls
            ? JSON.stringify(event.toolCalls)
            : null;
          this.sessionMessages
            .recordAssistant({
              id: event.messageId,
              sessionId,
              content: event.content,
              reasoning,
              toolCalls: toolCallsJson,
            })
            .catch((err) =>
              this.logger.error(
                `session_messages.recordAssistant 失败 msg=${event.messageId}`,
                err,
              ),
            );
          continue;
        }
        // event.kind === "usage"
        try {
          await this.llmCalls.record({
            sessionId,
            messageId: event.messageId,
            providerType: event.providerType,
            model: event.model,
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            totalTokens: event.totalTokens,
            cacheReadTokens: event.cacheReadTokens,
            cacheCreationTokens: event.cacheCreationTokens,
            reasoningTokens: event.reasoningTokens,
            durationMs: event.durationMs,
          });
        } catch (err) {
          this.logger.error(
            `LLM 调用观测落库失败 session=${sessionId} msg=${event.messageId}`,
            err,
          );
        }
        this.logger.log(
          `LLM call session=${sessionId} msg=${event.messageId} provider=${event.providerType} model=${event.model} in=${event.inputTokens}(cache_read=${event.cacheReadTokens} cache_creation=${event.cacheCreationTokens}) out=${event.outputTokens}(reasoning=${event.reasoningTokens}) total=${event.totalTokens} dur=${event.durationMs}ms`,
        );
        this.emitter.emit(SESSION_WS_EVENTS.runUsage, {
          sessionId,
          messageId: event.messageId,
          providerType: event.providerType,
          model: event.model,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          totalTokens: event.totalTokens,
          cacheReadTokens: event.cacheReadTokens,
          cacheCreationTokens: event.cacheCreationTokens,
          reasoningTokens: event.reasoningTokens,
          durationMs: event.durationMs,
        });
      }
      run.status = "done";
      const streamEndedAt = Date.now();
      await this.sessions.markProcessed(ids);
      const markProcessedMs = Date.now() - streamEndedAt;
      if (run.messageId) {
        this.emitter.emit(SESSION_WS_EVENTS.runDone, {
          sessionId,
          messageId: run.messageId,
          content: run.content,
        });
      }
      this.logger.log(
        `runOnce done session=${sessionId} total=${streamEndedAt - runStartedAt}ms markProcessed=${markProcessedMs}ms`,
      );
    } catch (err) {
      if (run.abort.signal.aborted) {
        run.status = "interrupted";
        this.emitter.emit(SESSION_WS_EVENTS.runInterrupted, {
          sessionId,
          messageId: run.messageId ?? "",
        });
      } else {
        await this.sessions.markFailed(ids);
        this.emitter.emit(SESSION_WS_EVENTS.runError, {
          sessionId,
          messageId: run.messageId,
          pendingIds: ids,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    } finally {
      this.inflight.delete(sessionId);
    }
  }

  /**
   * 监听 toolsNode emit 的 run.tool_call_end —— 把 tool result 写入
   * session_messages（role=tool）。fire-and-forget，写失败仅 log。
   *
   * gateway 转发给前端时已剥掉 content；runner 直接拿原始 event 含 content 落库。
   */
  @OnEvent(SESSION_WS_EVENTS.runToolCallEnd)
  async onToolCallEnd(payload: RunToolCallEndEvent): Promise<void> {
    try {
      await this.sessionMessages.recordToolResult({
        id: payload.toolCallId,
        sessionId: payload.sessionId,
        toolCallId: payload.toolCallId,
        content: payload.content,
      });
    } catch (err) {
      this.logger.error(
        `session_messages.recordToolResult 失败 toolCallId=${payload.toolCallId}`,
        err,
      );
    }
  }
}
