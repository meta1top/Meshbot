import {
  type DispatchSubagentPort,
  AccountContextService,
} from "@meshbot/agent";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { RunnerService } from "./runner.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";

/** 账号级并发上限（前台 fan-out 合计）。 */
const SUBAGENT_MAX_CONCURRENCY = 4;

/** 极简账号级信号量：超上限的 acquire 排队等待。 */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.queue.push(r));
    this.active++;
  }
  release(): void {
    if (this.active > 0) this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/**
 * DISPATCH_SUBAGENT_PORT 实现：把子任务委派给隔离子会话跑到完成（前台）。
 * 复用 RunnerService.kickAndWait 跑子会话（子会话 kind=subagent → GraphRunner 自动用子图）。
 */
@Injectable()
export class DispatchSubagentService implements DispatchSubagentPort {
  private readonly logger = new Logger(DispatchSubagentService.name);
  /** 按账号的并发信号量。 */
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(
    private readonly sessions: SessionService,
    private readonly messages: SessionMessageService,
    private readonly runner: RunnerService,
    private readonly emitter: EventEmitter2,
    private readonly account: AccountContextService,
  ) {}

  private semaphore(): Semaphore {
    const acct = this.account.getOrThrow();
    let s = this.semaphores.get(acct);
    if (!s) {
      s = new Semaphore(SUBAGENT_MAX_CONCURRENCY);
      this.semaphores.set(acct, s);
    }
    return s;
  }

  /**
   * 前台派发子 Agent：建子会话 → 跑到完成 → 回传末条 assistant 内容。
   * signal.abort 时中断子 run，随父会话一起停止。
   */
  async dispatch(
    params: {
      parentSessionId: string;
      parentToolCallId: string;
      task: string;
      description?: string;
      model?: string;
      background?: boolean;
    },
    signal: AbortSignal,
  ): Promise<string> {
    if (signal.aborted) {
      return JSON.stringify({
        subSessionId: "",
        status: "aborted",
        output: "",
      });
    }
    // 一层：父会话不存在或本身是 subagent 时拒绝派发。
    const parent = await this.sessions.findOrNull(params.parentSessionId);
    if (!parent || parent.kind === "subagent") {
      return JSON.stringify({
        subSessionId: "",
        status: "error",
        output: !parent
          ? "父会话不存在。"
          : "子 Agent 不能再派子 Agent（仅支持一层）。",
      });
    }

    const sem = this.semaphore();
    await sem.acquire();
    let subSessionId = "";
    try {
      const created = await this.sessions.createSubSession({
        parentSessionId: params.parentSessionId,
        parentToolCallId: params.parentToolCallId,
        task: params.task,
        description: params.description,
      });
      subSessionId = created.subSessionId;
      // 建好子会话即在父房间发关联事件，前端把父消息里那张 dispatch 卡认领到子会话。
      this.emitter.emit(SESSION_WS_EVENTS.runSubagentSpawned, {
        sessionId: params.parentSessionId,
        toolCallId: params.parentToolCallId,
        subSessionId,
        description: params.description ?? params.task.slice(0, 30),
      });
      // 父 run stop（signal abort）→ 中断子 run（前台随父）。
      const onAbort = () => this.runner.interrupt(subSessionId);
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        await this.runner.kickAndWait(subSessionId);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
      if (signal.aborted) {
        return JSON.stringify({ subSessionId, status: "aborted", output: "" });
      }
      const last = await this.messages.findLastAssistant(subSessionId);
      return JSON.stringify({
        subSessionId,
        status: "done",
        output: last?.content ?? "",
      });
    } catch (err) {
      this.logger.warn(
        `dispatch 子 Agent 失败 sub=${subSessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return JSON.stringify({
        subSessionId,
        status: "error",
        output: err instanceof Error ? err.message : String(err),
      });
    } finally {
      sem.release();
    }
  }
}
