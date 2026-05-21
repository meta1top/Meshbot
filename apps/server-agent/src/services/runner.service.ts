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

  constructor(
    private readonly sessions: SessionService,
    private readonly graph: GraphService,
    private readonly emitter: EventEmitter2,
  ) {}

  /** 启动时把遗留的 processing 消息退回 pending（重启 inflight 丢失后可重跑）。 */
  async onModuleInit(): Promise<void> {
    const n = await this.sessions.rollbackProcessingToPending();
    if (n > 0) {
      this.logger.log(`启动恢复：${n} 条遗留 processing 消息已退回 pending`);
    }
  }

  /** 启动消费循环（fire-and-forget）。已有 inflight 则跳过（防重入）。 */
  kick(sessionId: string): void {
    if (this.inflight.has(sessionId)) return;
    void this.kickAndWait(sessionId).catch((err) => {
      this.logger.error(`run loop crashed for ${sessionId}`, err);
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
   * runOnce 抛错时由内层 try/catch 吞掉以中断循环（避免毒消息无限重试），
   * 错误事件已在 runOnce 内发出，本方法对外正常 resolve。
   */
  async kickAndWait(sessionId: string): Promise<void> {
    if (this.inflight.has(sessionId)) return;
    try {
      while (true) {
        const batch = await this.sessions.claimPending(sessionId);
        if (batch.length === 0) break;
        try {
          await this.runOnce(sessionId, batch);
        } catch {
          break;
        }
      }
    } finally {
      await this.sessions.setStatus(sessionId, "idle");
    }
  }

  /** 跑一次 run：把一批消息拼成一次输入，流式产出并发事件。 */
  private async runOnce(
    sessionId: string,
    batch: { id: string; content: string }[],
  ): Promise<void> {
    const ids = batch.map((m) => m.id);
    const input = batch.map((m) => m.content).join("\n");
    const run: InflightRun = {
      messageId: null,
      content: "",
      status: "streaming",
      abort: new AbortController(),
    };
    this.inflight.set(sessionId, run);
    try {
      for await (const chunk of this.graph.streamMessage(
        sessionId,
        input,
        run.abort.signal,
      )) {
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
      this.emitter.emit(SESSION_WS_EVENTS.runDone, {
        sessionId,
        messageId: run.messageId ?? "",
        content: run.content,
      });
    } catch (err) {
      if (run.abort.signal.aborted) {
        run.status = "interrupted";
        this.emitter.emit(SESSION_WS_EVENTS.runInterrupted, {
          sessionId,
          messageId: run.messageId ?? "",
        });
      } else {
        await this.sessions.rollbackToPending(ids);
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
