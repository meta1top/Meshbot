import { randomUUID } from "node:crypto";
import {
  type DispatchSubagentPort,
  AccountContextService,
  capForLlm,
} from "@meshbot/agent";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { ModelConfigService } from "./model-config.service";
import { RunnerService } from "./runner.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";

/** 账号级并发上限（前台 fan-out 合计）。 */
const SUBAGENT_MAX_CONCURRENCY = 4;

/** updateToolResult 返回 0（tool 行尚未落库）时的重试等待。 */
const TOOL_RESULT_RETRY_DELAY_MS = 1000;

/** 子 Agent 终态判定结果。 */
interface TerminalState {
  status: "done" | "error" | "aborted";
  output: string;
}

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
 * DISPATCH_SUBAGENT_PORT 实现：把子任务委派给隔离子会话跑（前台阻塞至完成 /
 * 后台立即返回、跑完异步了结）。
 * 复用 RunnerService.kickAndWait 跑子会话（子会话 kind=subagent → GraphRunner 自动用子图）。
 */
@Injectable()
export class DispatchSubagentService
  implements DispatchSubagentPort, OnApplicationBootstrap
{
  private readonly logger = new Logger(DispatchSubagentService.name);
  /** 按账号的并发信号量。 */
  private readonly semaphores = new Map<string, Semaphore>();

  constructor(
    private readonly sessions: SessionService,
    private readonly messages: SessionMessageService,
    private readonly runner: RunnerService,
    private readonly emitter: EventEmitter2,
    private readonly account: AccountContextService,
    private readonly modelConfigs: ModelConfigService,
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
   * 子会话终态判定表：
   * - listActivePending 存在 failed → error（运行失败，未产出结果）
   * - 存在非 failed 的活跃条目（pending/processing）→ aborted（被中断，interrupt
   *   不会把消息转 failed / 回滚，只会遗留在 processing）
   * - 无活跃条目 → 查末条 assistant：无 → error（未产生任何回复）；有 → done
   */
  private async readTerminalState(
    subSessionId: string,
  ): Promise<TerminalState> {
    const active = await this.sessions.listActivePending(subSessionId);
    if (active.some((p) => p.status === "failed")) {
      return { status: "error", output: "子 Agent 运行失败，未产出结果。" };
    }
    if (active.length > 0) {
      return { status: "aborted", output: "" };
    }
    const last = await this.messages.findLastAssistant(subSessionId);
    if (!last) {
      return { status: "error", output: "子 Agent 未产生任何回复。" };
    }
    return { status: "done", output: last.content };
  }

  /**
   * 派发子 Agent：建子会话后按 background 分两条路径——
   * 前台：跑到完成，用终态判定表回传结果；
   * 后台：建好子会话即返回 running，交给 settleBackground 异步了结。
   * signal.abort 只影响前台（随父会话一起停）；后台脱离父 signal 生命周期。
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

    // model 解析放在 acquire 之前：查不到直接短路返回，不占并发槽位。
    let modelConfigId: string | undefined;
    if (params.model) {
      const model = await this.modelConfigs.findByIdOrName(params.model);
      if (!model) {
        return JSON.stringify({
          subSessionId: "",
          status: "error",
          output: `未找到模型配置「${params.model}」，请检查 model 参数（可用模型名见设置）。`,
        });
      }
      modelConfigId = model.id;
    }

    const sem = this.semaphore();
    await sem.acquire();
    let subSessionId = "";
    // 后台分支一旦把槽位移交给 settleBackground，本方法的 finally 就不能再释放
    // （否则同一把槽会被释放两次）——用这个标记区分「本方法自己释放」与「移交」。
    let slotTransferred = false;
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
        background: params.background === true,
        modelConfigId,
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

      if (params.background === true) {
        // 后台：不挂父 signal、不等待跑完——建好子会话立即返回 running，
        // 槽位移交给 settleBackground（其 finally 负责释放）；ALS 账号上下文
        // 会自动延续到这个 fire-and-forget 的后续执行里。
        slotTransferred = true;
        void this.settleBackground({
          subSessionId,
          parentSessionId: params.parentSessionId,
          parentToolCallId: params.parentToolCallId,
          description: params.description ?? params.task.slice(0, 30),
        }).catch((err) => {
          this.logger.warn(
            `settleBackground 失败 sub=${subSessionId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        return JSON.stringify({ subSessionId, status: "running" });
      }

      // 前台：父 run stop（signal abort）→ 中断子 run（前台随父）。
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
      const state = await this.readTerminalState(subSessionId);
      return JSON.stringify({ subSessionId, ...state });
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
      if (!slotTransferred) sem.release();
    }
  }

  /**
   * 了结一个后台子任务：跑到完成 → 终态判定 → 回灌父会话（播报消息 + 重写
   * tool 行 + settled 事件）→ 清 background 标记。
   *
   * **调用方持槽，本方法 finally 释放**（dispatch 后台分支 acquire 后把槽位移交
   * 给本方法；进程重启恢复路径由 Task 6 在显式 account.run 内调用，同样自己
   * 不 acquire、只负责用完释放）。public：Task 6（重启恢复）复用。
   */
  public async settleBackground(args: {
    subSessionId: string;
    parentSessionId: string;
    parentToolCallId: string;
    description: string;
  }): Promise<void> {
    const sem = this.semaphore();
    try {
      await this.runner.kickAndWait(args.subSessionId);
      const state = await this.readTerminalState(args.subSessionId);
      const cappedOutput = capForLlm(state.output);
      const finalJson = JSON.stringify({
        subSessionId: args.subSessionId,
        status: state.status,
        output: cappedOutput,
      });
      const parent = await this.sessions.findOrNull(args.parentSessionId);
      if (parent) {
        const statusText =
          state.status === "done"
            ? "已完成"
            : state.status === "error"
              ? "失败"
              : "已中止";
        const content =
          `子任务「${args.description}」${statusText}。` +
          (state.output ? `\n结果：\n${cappedOutput}` : "");

        // appendMessage 抛错重试一次；仍失败则记录后直接 return——保持
        // background=1，让下次进程重启的恢复扫描（Task 6）能再次尝试了结。
        let appended = false;
        for (let attempt = 0; attempt < 2 && !appended; attempt++) {
          try {
            await this.sessions.appendMessage(args.parentSessionId, {
              messageId: randomUUID(),
              content,
            });
            appended = true;
          } catch (err) {
            this.logger.warn(
              `settleBackground appendMessage 失败(第${attempt + 1}次) sub=${args.subSessionId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (!appended) return;

        this.runner.kick(args.parentSessionId);

        // tool 行可能与本方法存在落库竞速（父 run 消费循环 append 那条
        // tool 消息的时机不确定）：0 表示尚未落库，等一拍重试一次。
        let affected = await this.messages.updateToolResult(
          args.parentToolCallId,
          finalJson,
        );
        if (affected === 0) {
          await new Promise((r) => setTimeout(r, TOOL_RESULT_RETRY_DELAY_MS));
          affected = await this.messages.updateToolResult(
            args.parentToolCallId,
            finalJson,
          );
          if (affected === 0) {
            this.logger.warn(
              `settleBackground updateToolResult 未命中 tool 行 sub=${args.subSessionId} toolCallId=${args.parentToolCallId}`,
            );
          }
        }

        this.emitter.emit(SESSION_WS_EVENTS.runSubagentSettled, {
          sessionId: args.parentSessionId,
          toolCallId: args.parentToolCallId,
          subSessionId: args.subSessionId,
          status: state.status,
          output: cappedOutput,
        });
      }
      // 父已删：跳过播报/重写/事件，仍要清掉 background 标记（无父可了结）。
      await this.sessions.setBackground(args.subSessionId, false);
    } finally {
      sem.release();
    }
  }

  /**
   * 重启恢复：扫描所有账号「待了结的后台子任务」（background=1），逐个在归属账号
   * 上下文内取槽 → settleBackground（kickAndWait 对无 pending 的会话是 no-op，
   * 天然覆盖「宕机时没跑完→续跑」与「跑完但播报丢失→补播报」两分支）。
   * fire-and-forget：恢复不阻塞启动；单任务失败只记日志。
   *
   * 生命周期时机：Nest 保证 onApplicationBootstrap 晚于所有模块的
   * onModuleInit（含 RunnerService.onModuleInit 的 processing→pending 回滚），
   * 因此本方法扫到的 background=1 会话，其 pending 状态已经是回滚后的稳态。
   *
   * 紧接着扫描「孤儿前台子会话」（background=0 但仍有活跃 pending）：这类会话
   * 的父 run 是同步等待，进程重启即意味着父上下文已死，无人会再消费其结果——
   * 语义已拍板为只标记了结（markFailed + setStatus idle），不重跑，也不占
   * 信号量（没有 run 要跑）。
   */
  async onApplicationBootstrap(): Promise<void> {
    const rows = await this.sessions.listPendingBackgroundSubagentsUnscoped();
    if (rows.length > 0) {
      this.logger.log(`重启恢复：发现 ${rows.length} 个待了结后台子任务`);
      for (const row of rows) {
        if (!row.parentSessionId || !row.parentToolCallId) continue;
        void this.account
          .run(row.cloudUserId, async () => {
            await this.semaphore().acquire();
            await this.settleBackground({
              subSessionId: row.id,
              parentSessionId: row.parentSessionId as string,
              parentToolCallId: row.parentToolCallId as string,
              description: row.title ?? "后台任务",
            });
          })
          .catch((err) =>
            this.logger.warn(`重启恢复 settle 失败 sub=${row.id}`, err),
          );
      }
    }

    const orphanRows =
      await this.sessions.listOrphanForegroundSubagentsUnscoped();
    if (orphanRows.length === 0) return;
    this.logger.log(`重启恢复：了结 ${orphanRows.length} 个孤儿前台子会话`);
    for (const row of orphanRows) {
      void this.account
        .run(row.cloudUserId, async () => {
          const active = await this.sessions.listActivePending(row.id);
          await this.sessions.markFailed(active.map((p) => p.id));
          await this.sessions.setStatus(row.id, "idle");
        })
        .catch((err) =>
          this.logger.warn(
            `重启恢复 孤儿前台子会话了结失败 sub=${row.id}`,
            err,
          ),
        );
    }
  }
}
