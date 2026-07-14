import {
  AccountContextService,
  AgentContextService,
  GraphRunner,
  McpService,
  ModelRunContext,
} from "@meshbot/lib-agent";
import {
  type InflightToolCall,
  type RunToolCallEndEvent,
  SESSION_WS_EVENTS,
} from "@meshbot/types-agent";
import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { AgentService } from "./agent.service";
import { ContextCompactor } from "./context-compactor.service";
import { isContextLengthError } from "./context-compactor.utils";
import { LlmCallService } from "./llm-call.service";
import { ModelConfigService } from "./model-config.service";
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
  /**
   * 当前轮 reasoning 首个 chunk 到达的时间戳（ms）。
   * - 进入新轮（messageId 切换）时重置为 null
   * - 收到本轮第一个 reasoning event 时记录 Date.now()
   * 用途：getInflight 返回，前端刷新替换 onReasoning 现取 Date.now() 的错误兜底。
   */
  reasoningStartedAt: number | null;
  /**
   * 当前轮 args 流式中的工具调用（toolCallId → 累计 args 文本）；切轮清空。
   * tool_call_args 本身是纯瞬态事件，不留痕的话中途订阅者只能收到 args 尾巴
   * 片段（拼不出合法 JSON），工具卡要空转到 tool_call_start 才整包补齐。
   */
  toolCalls: Map<string, { name: string; argsText: string }>;
  status: "streaming" | "done" | "interrupted";
  abort: AbortController;
  /** ctx-exceeded 兜底重试标记；防止同一 run 重复触发兜底。 */
  retried?: boolean;
  /**
   * 当前轮 assistant 是否已 recordAssistant 落库。落库后该轮不再作为活 partial
   * 吐出（getInflight 返 messageId:null），避免「已落库轮」被刷新当成 inflight
   * 重复推成「思考中」并误计时。轮切换（新轮 reasoning/chunk）时重置为 false。
   */
  partialPersisted: boolean;
}

/** getInflight 对外快照（subscribe replay 用）。 */
export interface InflightView {
  messageId: string | null;
  content: string;
  reasoning: string;
  /**
   * 当前轮 reasoning 首个 chunk 到达的时间戳（ms）。
   * - 进入新轮（messageId 切换）时重置为 null
   * - 收到本轮第一个 reasoning event 时记录 Date.now()
   * 用途：getInflight 返回，前端刷新替换 onReasoning 现取 Date.now() 的错误兜底。
   */
  reasoningStartedAt: number | null;
  /** 本轮 args 流式中的工具调用；已落库轮 / 无工具时为空数组。 */
  toolCalls: InflightToolCall[];
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
    private readonly graphRunner: GraphRunner,
    private readonly emitter: EventEmitter2,
    private readonly llmCalls: LlmCallService,
    private readonly sessionMessages: SessionMessageService,
    private readonly compactor: ContextCompactor,
    private readonly modelConfig: ModelConfigService,
    private readonly account: AccountContextService,
    private readonly modelRunCtx: ModelRunContext,
    private readonly agentCtx: AgentContextService,
    private readonly agents: AgentService,
    private readonly mcp: McpService,
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
    // 本轮 assistant 已落库：history 已含整条（reasoning + tool_calls），不再吐
    // 活 partial，避免重复气泡 + 「思考中」误计时；但 status 仍 streaming，让前端
    // 知道 run 在跑（停止按钮 / 输入态不变）。messageId:null → 不推气泡、不回放。
    if (run.partialPersisted) {
      return {
        messageId: null,
        content: "",
        reasoning: "",
        reasoningStartedAt: null,
        toolCalls: [],
        status: run.status,
      };
    }
    return {
      messageId: run.messageId,
      content: run.content,
      reasoning: run.reasoning,
      reasoningStartedAt: run.reasoningStartedAt,
      toolCalls: [...run.toolCalls].map(([toolCallId, tc]) => ({
        toolCallId,
        name: tc.name,
        argsText: tc.argsText,
      })),
      status: run.status,
    };
  }

  /**
   * 进入新一轮 assistant（messageId 变了）时重置本轮累计快照。
   *
   * reasoning / chunk / tool_call_args 三个分支共用：其中 tool_call_args 尤其
   * 关键——「决策轮」（只吐 tool_calls，无正文、云网关也不透传 reasoning）没有
   * reasoning/chunk 事件，不在这里设 messageId 的话 run.messageId 永远是 null，
   * getInflight 直接返 messageId:null → subscribe 一个快照都不发，中途打开会话
   * 就完全看不到正在流式生成的工具调用。
   */
  private beginRoundIfNew(run: InflightRun, messageId: string): void {
    if (run.messageId === messageId) return;
    run.messageId = messageId;
    run.content = "";
    run.reasoning = "";
    run.reasoningStartedAt = null;
    run.toolCalls.clear();
    // 进入新轮：上一轮的「已落库」标志失效，新轮重新作为活 partial 吐出。
    run.partialPersisted = false;
  }

  /** 中断某 session 当前 run。 */
  interrupt(sessionId: string): void {
    this.inflight.get(sessionId)?.abort.abort();
  }

  /**
   * 消费循环：取 pending → 跑一次 run → 检查是否还有 pending → 续跑。
   * 测试直接 await 本方法；生产经 kick 触发不 await。
   *
   * 先按 session 反查归属账号（系统级，无上下文），再把整段消费包进该账号的
   * ALS 上下文里——后台触发（runner / cron）天生无请求上下文，必须显式建账号
   * 上下文，否则下游作用域服务（Session / SessionMessage / LlmCall）会抛
   * NO_ACCOUNT_CONTEXT。HTTP 触发路径包进来语义不变（仍是该 session 属主）。
   *
   * running 哨兵在第一个 await 之前同步设置，防止同 tick 内双 kick 竞争。
   * runOnce 抛错时由内层 try/catch 记录日志后中断循环（避免毒消息无限重试），
   * 错误事件已在 runOnce 内发出，本方法对外正常 resolve。
   */
  async kickAndWait(sessionId: string): Promise<void> {
    const owner = await this.sessions.findOwner(sessionId);
    if (!owner) {
      this.logger.warn(`kick ${sessionId}: 找不到归属账号，跳过`);
      return;
    }
    await this.account.run(owner, async () => {
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
    });
  }

  /**
   * 重试消费循环：取 failed 消息 → resume run（不写新 HumanMessage）→
   * 检查是否还有 failed → 续跑。测试直接 await 本方法；生产经 kickRetry 触发不 await。
   *
   * 结构与 kickAndWait 一致：先建该 session 属主的账号上下文（后台触发无请求
   * 上下文），running 哨兵防双 kick，runOnce 抛错时记录日志后中断循环。
   */
  async kickRetryAndWait(sessionId: string): Promise<void> {
    const owner = await this.sessions.findOwner(sessionId);
    if (!owner) {
      this.logger.warn(`kickRetry ${sessionId}: 找不到归属账号，跳过`);
      return;
    }
    await this.account.run(owner, async () => {
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
    });
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
    const owner = await this.sessions.findOwner(sessionId);
    if (!owner) {
      this.logger.warn(`kickResume ${sessionId}: 找不到归属账号，跳过`);
      return;
    }
    await this.account.run(owner, async () => {
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
    });
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
      reasoningStartedAt: null,
      toolCalls: new Map(),
      status: "streaming",
      abort: new AbortController(),
      partialPersisted: false,
    };
    this.inflight.set(sessionId, run);
    const runStartedAt = Date.now();
    this.logger.log(
      `runOnce start session=${sessionId} batch=${ids.length} resume=${resume}`,
    );

    // === pre-check：resume 模式跳过（checkpointer 现有状态，阈值不适用） ===
    if (!resume) {
      try {
        const lastCall = await this.llmCalls.getLastBySession(sessionId);
        const model = await this.modelConfig.findEnabled();
        if (
          lastCall &&
          model &&
          this.compactor.shouldCompact(
            lastCall.inputTokens,
            model.contextWindow,
          )
        ) {
          this.logger.log(
            `pre-check 命中阈值 session=${sessionId} input=${lastCall.inputTokens} ctx=${model.contextWindow} → 同步压缩`,
          );
          await this.compactor.compact(sessionId, { reason: "threshold" });
        }
      } catch (preErr) {
        this.logger.warn(
          `pre-check 压缩失败 session=${sessionId}：${preErr instanceof Error ? preErr.message : String(preErr)}`,
        );
        // 顺序：先 delete inflight（同步、不可失败），再 markFailed（异步可失败）。
        // 反过来若 markFailed 抛错，inflight 会泄漏成 stale streaming 状态。
        this.inflight.delete(sessionId);
        await this.sessions.markFailed(ids);
        this.emitter.emit(SESSION_WS_EVENTS.runError, {
          sessionId,
          messageId: null,
          pendingIds: ids,
          error: preErr instanceof Error ? preErr.message : String(preErr),
        });
        throw preErr;
      }
    }

    try {
      await this.consumeRunStream(sessionId, batch, run, resume, runStartedAt);
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
      // === ctx-exceeded 兜底：强制压缩 + 重试一次 ===
      // 只对非 resume 情况启用（resume 拿不到 batch 文本，没法重发）；
      // run.abort.signal 已 aborted 时不兜底（用户主动 stop）；
      // 只重试一次：run.retried flag 防止递归。
      if (
        !resume &&
        !run.abort.signal.aborted &&
        isContextLengthError(err) &&
        !run.retried
      ) {
        this.logger.warn(
          `ctx_exceeded session=${sessionId}; 强制压缩并重试一次`,
        );
        try {
          await this.compactor.compact(sessionId, {
            force: true,
            reason: "ctx-exceeded",
          });
        } catch (compactErr) {
          this.logger.warn(
            `兜底压缩失败 session=${sessionId}：${compactErr instanceof Error ? compactErr.message : String(compactErr)}`,
          );
          // 压缩兜底失败：报 compactErr（更新鲜，指向真实失败点），
          // 不再屏蔽 ctx_exceeded 这个最初触发原因。
          await this.sessions.markFailed(ids);
          this.emitter.emit(SESSION_WS_EVENTS.runError, {
            sessionId,
            messageId: run.messageId,
            pendingIds: ids,
            error:
              compactErr instanceof Error
                ? compactErr.message
                : String(compactErr),
          });
          throw compactErr;
        }
        run.retried = true;
        // 重试一次走 resume 模式：第一次 streamMessage 已经把 batch 的
        // HumanMessage 写进 checkpointer 了；compact 完成后 batch 的 user
        // 消息仍在保留区（最近 N 条之内）。若用 streamMessage 重发会重复
        // 写一条同 id 的 HumanMessage（reducer 不去重），并把 run.human
        // 事件再发一次让前端 user 气泡跳位。
        try {
          await this.consumeRunStream(sessionId, [], run, true, runStartedAt);
          run.status = "done";
          const streamEndedAt = Date.now();
          await this.sessions.markProcessed(ids);
          const markProcessedMs = Date.now() - streamEndedAt;
          this.logger.log(
            `runOnce retry 成功 session=${sessionId} markProcessed=${markProcessedMs}ms`,
          );
          if (run.messageId) {
            this.emitter.emit(SESSION_WS_EVENTS.runDone, {
              sessionId,
              messageId: run.messageId,
              content: run.content,
            });
          }
          return;
        } catch (retryErr) {
          // 重试也失败 → 走原失败路径，抛 retryErr（更新鲜）
          await this.sessions.markFailed(ids);
          this.emitter.emit(SESSION_WS_EVENTS.runError, {
            sessionId,
            messageId: run.messageId,
            pendingIds: ids,
            error:
              retryErr instanceof Error ? retryErr.message : String(retryErr),
          });
          throw retryErr;
        }
      }

      // 原有 catch 逻辑（abort vs 失败）保持不变
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
   * stream 消费入口：先读 session 拿 kind（subAgent 判定）、agentId、modelConfigId，
   * 再把「建流 + for-await 消费 + finally」整段包进 AgentContext + ModelRunContext ——
   * async generator 的 next() 跑在调用方（本方法）的 ALS 上下文里，包裹范围必须
   * 覆盖整个消费循环，只包建流无效。
   *
   * 模型三级优先级：会话覆盖 > Agent 默认 > 账号启用首行（最后一级由 ModelResolver 兜底）。
   *
   * MCP 按 Agent 懒加载（Task 6）：在 AgentContext 内、建流之前 `ensureAgent`
   * 拉起该 Agent 的 MCP（已就绪则只刷新 lastUsedAt），`acquire` 挂引用计数
   * 防止闲置回收在 run 进行中把工具抽走；`release` 必须在 finally 里——否则
   * run 抛错时引用计数永久泄漏，该 Agent 的 MCP 再也回收不掉。
   */
  private async consumeRunStream(
    sessionId: string,
    batch: { id: string; content: string }[],
    run: InflightRun,
    resume: boolean,
    runStartedAt: number,
  ): Promise<void> {
    const cloudUserId = this.account.getOrThrow();
    const session = await this.sessions.findOrNull(sessionId);
    const subAgent = session?.kind === "subagent";
    // 真值判断而非 `??`：`??` 只在 null/undefined 时才走兜底，historical 存量行
    // （迁移默认值 ''）或落库时漏校验的空字符串会原样通过 `??`，把空串压进
    // ALS（AgentContextService.getOrThrow 判空会抛错）。用 `||` 让空串与
    // null/undefined 一样触发 ensureDefault 兜底。
    const agentId = session?.agentId || (await this.agents.ensureDefault()).id;
    const agent = await this.agents.findOrNull(agentId);
    // 模型三级优先级同理：`??` 挡不住空串，空字符串会被误判为「会话已覆盖」，
    // 静默跳过 Agent 默认模型这一级（ModelResolver 的三元把 '' 当 falsy 又
    // 意外兜回账号默认，行为不崩但完全违背设计意图，且无任何日志）。
    const modelOverride =
      session?.modelConfigId || agent?.defaultModelConfigId || null;
    await this.agentCtx.run(agentId, async () => {
      await this.mcp.ensureAgent(cloudUserId, agentId);
      this.mcp.acquire(cloudUserId, agentId);
      try {
        await this.modelRunCtx.run(modelOverride, () =>
          this.consumeRunStreamInCtx(
            sessionId,
            batch,
            run,
            resume,
            runStartedAt,
            subAgent,
          ),
        );
      } finally {
        this.mcp.release(cloudUserId, agentId);
      }
    });
  }

  /**
   * consumeRunStream 的原有主体（建流 + 逐事件消费），整体运行在
   * ModelRunContext 内。机械提取自原 runOnce try 块，语义完全等价。
   * 供 ctx-exceeded 兜底重试复用。
   */
  private async consumeRunStreamInCtx(
    sessionId: string,
    batch: { id: string; content: string }[],
    run: InflightRun,
    resume: boolean,
    runStartedAt: number,
    subAgent: boolean,
  ): Promise<void> {
    let firstHumanLogged = false;
    let firstChunkLogged = false;
    const stream = resume
      ? this.graphRunner.resumeStream(sessionId, run.abort.signal, { subAgent })
      : this.graphRunner.streamMessage(sessionId, batch, run.abort.signal, {
          subAgent,
        });
    for await (const event of stream) {
      if (event.kind === "human") {
        if (!firstHumanLogged) {
          firstHumanLogged = true;
          this.logger.log(
            `runOnce first-human session=${sessionId} +${Date.now() - runStartedAt}ms`,
          );
        }
        const content =
          batch.find((b) => b.id === event.messageId)?.content ?? "";
        this.emitter.emit(SESSION_WS_EVENTS.runHuman, {
          sessionId,
          messageId: event.messageId,
          content,
        });
        // 双写 session_messages：顺序 await 保证同一批 human 按 emit 顺序拿到
        // 递增 seq（fire-and-forget 并发会让 seq 反映插入竞速顺序而非 emit
        // 顺序，刷新后时序错乱）。写失败仅 log，不杀 run。
        try {
          await this.sessionMessages.recordUser({
            id: event.messageId,
            sessionId,
            content,
          });
        } catch (err) {
          this.logger.error(
            `session_messages.recordUser 失败 msg=${event.messageId}`,
            err,
          );
        }
        continue;
      }
      if (event.kind === "reasoning") {
        // 同步更新 inflight reasoning 快照，让 subscribe 中途接入也能 replay
        // 已收到的思考内容（多轮 ReAct 切轮时 messageId 变化会清空旧 reasoning）。
        this.beginRoundIfNew(run, event.messageId);
        // 本轮首个 reasoning delta：记下 startedAt，刷新时前端能拿到真实开始时间
        if (run.reasoning === "" && event.delta) {
          run.reasoningStartedAt = Date.now();
        }
        run.reasoning += event.delta;
        this.emitter.emit(SESSION_WS_EVENTS.runReasoning, {
          sessionId,
          messageId: event.messageId,
          delta: event.delta,
        });
        continue;
      }
      if (event.kind === "reasoning_done") {
        // 本轮 LLM reasoning_content 阶段结束、转入 tool_calls token 流。
        // 前端据此尽早锁 reasoningDurationMs，把「思考中 Xs」切到「已思考 Xs」，
        // 不再把后续几秒的 tool_calls token 流时间算进思考时长。
        this.emitter.emit(SESSION_WS_EVENTS.runReasoningDone, {
          sessionId,
          messageId: event.messageId,
        });
        continue;
      }
      if (event.kind === "tool_calls") {
        // tool_calls 在 assistant_done 里一并带过来，这里不需要单独处理
        continue;
      }
      if (event.kind === "tool_call_args") {
        // 不落库，但要累进 inflight 快照：中途订阅者靠它续上「已经流过去的」args
        // 前缀，否则只拿到尾巴片段、解析不出 JSON，工具卡空转到 tool_call_start
        // 才整包补齐（写文件这类长 args 尤其明显）。同时这里也是「决策轮」唯一
        // 能设 run.messageId 的地方（无 reasoning/chunk 事件），见 beginRoundIfNew。
        this.beginRoundIfNew(run, event.messageId);
        if (event.toolCallId) {
          const cur = run.toolCalls.get(event.toolCallId);
          if (cur) {
            cur.argsText += event.delta;
            if (event.name) cur.name = event.name;
          } else {
            run.toolCalls.set(event.toolCallId, {
              name: event.name ?? "",
              argsText: event.delta,
            });
          }
        }
        // 必须在此 continue，否则会落进末尾的 usage 兜底分支
        // （event 字段不匹配 → 误记 LLM 调用）。
        this.emitter.emit(SESSION_WS_EVENTS.runToolCallArgsDelta, {
          sessionId,
          messageId: event.messageId,
          toolCallId: event.toolCallId,
          index: event.index,
          name: event.name,
          delta: event.delta,
        });
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
        this.beginRoundIfNew(run, event.messageId);
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
        // 顺序 await：保证 assistant 接续本批 human 的 seq（emit 顺序）。
        try {
          await this.sessionMessages.recordAssistant({
            id: event.messageId,
            sessionId,
            content: event.content,
            reasoning,
            toolCalls: toolCallsJson,
          });
        } catch (err) {
          this.logger.error(
            `session_messages.recordAssistant 失败 msg=${event.messageId}`,
            err,
          );
        }
        // 本轮 assistant 已落库：history 已含整条（reasoning + tool_calls），
        // getInflight 不再吐活 partial，避免刷新重复推「思考中」+ 误计时。
        run.partialPersisted = true;
        continue;
      }
      // event.kind === "usage"
      try {
        await this.llmCalls.record({
          sessionId,
          messageId: event.messageId,
          providerType: event.providerType,
          model: event.model,
          modelName: event.modelName,
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
        modelName: event.modelName,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        totalTokens: event.totalTokens,
        cacheReadTokens: event.cacheReadTokens,
        cacheCreationTokens: event.cacheCreationTokens,
        reasoningTokens: event.reasoningTokens,
        durationMs: event.durationMs,
      });
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
        // 透传失败标记 → metadata.ok=false → history 回放能复原红色失败态
        ok: payload.ok,
      });
    } catch (err) {
      this.logger.error(
        `session_messages.recordToolResult 失败 toolCallId=${payload.toolCallId}`,
        err,
      );
    }
  }
}
