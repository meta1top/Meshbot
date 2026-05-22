import { GraphService } from "@meshbot/agent";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { SessionService } from "./session.service";

/** 进程内 run 的内存状态。 */
interface InflightRun {
  messageId: string | null;
  content: string;
  status: "streaming" | "done" | "interrupted";
  abort: AbortController;
}

/** getInflight 对外快照。 */
export interface InflightView {
  messageId: string | null;
  content: string;
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

  /** 取某 session 当前 inflight 快照；无则 null。 */
  getInflight(sessionId: string): InflightView | null {
    const run = this.inflight.get(sessionId);
    if (!run) return null;
    return {
      messageId: run.messageId,
      content: run.content,
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
      status: "streaming",
      abort: new AbortController(),
    };
    this.inflight.set(sessionId, run);
    try {
      const stream = resume
        ? this.graph.resumeStream(sessionId, run.abort.signal)
        : this.graph.streamMessage(sessionId, batch, run.abort.signal);
      for await (const chunk of stream) {
        run.messageId = chunk.messageId;
        run.content += chunk.delta;
        this.emitter.emit(SESSION_WS_EVENTS.runChunk, {
          sessionId,
          messageId: chunk.messageId,
          delta: chunk.delta,
        });
      }
      run.status = "done";
      await this.sessions.markProcessed(ids);
      if (run.messageId) {
        this.emitter.emit(SESSION_WS_EVENTS.runDone, {
          sessionId,
          messageId: run.messageId,
          content: run.content,
        });
      }
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
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    } finally {
      this.inflight.delete(sessionId);
    }
  }
}
