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

/**
 * 极简账号级信号量：超上限的 acquire 排队等待。
 *
 * release() 时若有排队者，把槽位直接「转交」给它（active 计数不变），不走
 * decrement→wake→（排队者恢复后）increment 的两步式；否则 release 先
 * active-- 再异步唤醒排队者（排队者的 acquire() 要等其 await 恢复执行才
 * 会 active++），这两步之间存在一个 active 被短暂低估的窗口——若一个全新的
 * acquire() 恰好落在这个窗口里检查 `active < max`，会被立即放行，造成瞬时
 * 超发（超过 max 个并发持有者）。
 */
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
    // 槽位由 release() 直接转交（见下），恢复执行时无需再自增。
  }
  release(): void {
    const next = this.queue.shift();
    if (next) {
      // 转交槽位给下一个排队者：active 计数不变（相当于原持有者的名额原地
      // 换人），不经过 decrement→increment 的中间态，杜绝上述超发窗口。
      next();
      return;
    }
    if (this.active > 0) this.active--;
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
      // 排队等槽位期间父 run 可能已 abort：此时立即短路，不建子会话
      // （finally 已释放槽位）。此前只有函数入口一处 abort 检查，
      // acquire() 可能排在 4 个在跑子 run 后面阻塞很久，这段等待期间的
      // abort 会被漏判。
      if (signal.aborted) {
        return JSON.stringify({
          subSessionId: "",
          status: "aborted",
          output: "",
        });
      }
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
      // 建子会话期间父 run 也可能已 abort：跑之前再查一次，避免白跑一个
      // 完整子 run。走到这里确认未 abort 后才订阅——给已 aborted 的 signal
      // addEventListener 永远不会触发回调，必须先检查再订阅（标准防御写法）。
      if (signal.aborted) {
        return JSON.stringify({ subSessionId, status: "aborted", output: "" });
      }
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
      // kickAndWait 吞掉了 runOnce 的失败（log + break 后正常 resolve），
      // 必须显式查子会话是否有 failed 的 pending 消息，否则失败会被误报
      // 成 status:"done"（output 空/陈旧），父 LLM 无从感知子任务失败。
      const failed = await this.sessions.hasFailedPending(subSessionId);
      if (failed) {
        return JSON.stringify({
          subSessionId,
          status: "error",
          output: "子 Agent 运行失败，未产出结果。",
        });
      }
      const last = await this.messages.findLastAssistant(subSessionId);
      if (!last) {
        // 未失败但也没有落库任何 assistant 消息——同样不能报 done。
        return JSON.stringify({
          subSessionId,
          status: "error",
          output: "子 Agent 未产生任何回复。",
        });
      }
      return JSON.stringify({
        subSessionId,
        status: "done",
        output: last.content,
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
