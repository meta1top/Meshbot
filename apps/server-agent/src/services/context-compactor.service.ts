import {
  ThreadStateService,
  ModelResolver,
  COMPACTION_SYSTEM_PROMPT,
} from "@meshbot/lib-agent";
import { SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { randomUUID } from "node:crypto";
import {
  expandToToolBoundary,
  findSplitIndex,
  serializeForSummary,
} from "./context-compactor.utils";
import { LlmCallService } from "./llm-call.service";
import { ModelConfigService } from "./model-config.service";
import { SessionMessageService } from "./session-message.service";

// === 配置常量（v1 hardcoded；v2 挪到 ModelConfig 列或单独配置） ===
const COMPACTION_TRIGGER_RATIO = 0.9;
const COMPACTION_RECENT_RATIO = 0.1;
const COMPACTION_SUMMARY_MAX_TOKENS = 1500;
const COMPACTION_SUMMARIZE_TIMEOUT_MS = 60_000;

/** 触发场景标签，影响 WS 事件的 reason 字段。 */
export type CompactionReason = "threshold" | "ctx-exceeded";

export interface CompactOptions {
  /** force=true 时，即便没东西可压也抛 CompactionNothingToCompact（兜底场景）。 */
  force?: boolean;
  /** 触发原因，默认 "threshold"。 */
  reason?: CompactionReason;
}

export interface CompactionResult {
  removedCount: number;
  summary: string;
}

/** 压缩流程统一错误类（getState / summarize / updateState 失败均包装成此）。 */
export class CompactionError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "CompactionError";
  }
}

/** force 模式下没东西可压时抛此错。Runner 据此判定"压缩兜底彻底没救"。 */
export class CompactionNothingToCompact extends Error {
  constructor() {
    super("Nothing to compact (force=true)");
    this.name = "CompactionNothingToCompact";
  }
}

/**
 * 会话上下文压缩器（per-sessionId 锁 + 同步等待）。
 *
 * - `compact(sessionId)` 是入口：进锁 → 取 messages → 算切分 → summarize →
 *   applyCompaction → recordCompactionPlaceholder → emit done。
 * - 失败时 emit error 抛 CompactionError；调用方（runner）决定是否兜底。
 * - 并发同 sessionId 第二次调用直接 await 第一次的 Promise。
 *
 * 设计稿：docs/superpowers/specs/2026-05-26-context-compaction-design.md
 */
@Injectable()
export class ContextCompactor {
  private readonly logger = new Logger(ContextCompactor.name);
  private readonly locks = new Map<string, Promise<CompactionResult | null>>();

  constructor(
    private readonly threadState: ThreadStateService,
    private readonly modelResolver: ModelResolver,
    private readonly modelConfig: ModelConfigService,
    private readonly sessionMessages: SessionMessageService,
    // 非死代码——已排查是漏写的调用方，非误删候选。
    // 设计稿 docs/superpowers/specs/2026-05-26-context-compaction-design.md §2 明确要求
    // v1 就该把 summarize() 这次 LLM 调用写一行 llm_calls（未打 purpose 标记，直接 merge
    // 进 sessionTotals），§10 只把"单独打标记、从 sessionTotals 里摘除"这部分推迟到 v2。
    // 但落地时的实施 plan（docs/superpowers/plans/2026-05-26-context-compaction.md）
    // 未把这行 record() 列进文件改动表，实现里也确实从未调用过，测试里长期用
    // `{ provide: LlmCallService, useValue: {} }` 空对象 mock 也能全绿——
    // 说明 doCompact() 里 modelResolver.summarize() 消耗的 token 至今未落库，
    // 对 session 的 usage 累计（getSessionTotals）/ 全局用量看板（stats.service.ts）
    // 都是隐形的。真正的修复需要：① ModelResolver.summarize() 从 model.invoke()
    // 的响应里提取 usage（可复用 graph-runner.service.ts 的 extractUsage()，目前未导出）
    // 并把返回值从 Promise<string> 改成带 usage 的结构；② 这里补一次 llmCalls.record()。
    // 这属于改共享 chat-model 解析服务返回签名 + 触碰压缩兜底这条状态机路径的改动，
    // 按仓库风险分档接近"跨设备协议/带生命周期状态机"一档，需要独立 review + 变异验证，
    // 不适合在本次 lint 清理里顺手改掉，先保留字段 + 留痕，交给后续任务处理。
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: 见上——设计稿要求 v1 记账、实施 plan 漏写调用方，非死代码。
    private readonly llmCalls: LlmCallService,
    private readonly emitter: EventEmitter2,
  ) {}

  /** 给 runner pre-check 用：返 true 表示当前 lastInputTokens 已触阈值。 */
  shouldCompact(lastInputTokens: number, contextWindow: number): boolean {
    if (!contextWindow || contextWindow <= 0) return false;
    return lastInputTokens / contextWindow >= COMPACTION_TRIGGER_RATIO;
  }

  /** 入口：同步等待压缩完成。同 sessionId 并发会被锁串行化。 */
  async compact(
    sessionId: string,
    opts: CompactOptions = {},
  ): Promise<CompactionResult | null> {
    const existing = this.locks.get(sessionId);
    if (existing) return existing;
    const p = this.doCompact(sessionId, opts).finally(() =>
      this.locks.delete(sessionId),
    );
    this.locks.set(sessionId, p);
    return p;
  }

  private async doCompact(
    sessionId: string,
    opts: CompactOptions,
  ): Promise<CompactionResult | null> {
    const reason: CompactionReason = opts.reason ?? "threshold";
    const model = await this.modelConfig.findEnabled();
    if (!model) {
      throw new CompactionError("No enabled ModelConfig");
    }
    const ctx = model.contextWindow;
    const messages = await this.threadState.getMessagesSnapshot(sessionId);

    // 切分
    const keepBudget = Math.floor(ctx * COMPACTION_RECENT_RATIO);
    let splitIdx = findSplitIndex(messages, keepBudget);
    splitIdx = expandToToolBoundary(messages, splitIdx);
    if (splitIdx === 0) {
      if (opts.force) throw new CompactionNothingToCompact();
      return null;
    }
    // 保留区不足 2 条 → 强制把 splitIdx 往前挪（让 keep 区至少留 2 条），
    // 哪怕这意味着这一轮没东西可压（splitIdx 被挪到 0）。
    if (messages.length - splitIdx < 2) {
      splitIdx = Math.max(0, messages.length - 2);
    }
    // 二次确认 splitIdx：若上面的调整把它压回 0，说明 messages 总条数
    // 太少，没东西可压。复用同一套语义：非 force 返 null，force 抛错。
    if (splitIdx === 0) {
      if (opts.force) throw new CompactionNothingToCompact();
      return null;
    }
    const toSummarize = messages.slice(0, splitIdx);
    const keep = messages.slice(splitIdx);

    // 发 start 事件
    this.emitter.emit(SESSION_WS_EVENTS.runCompactionStart, {
      sessionId,
      reason,
    });

    let summaryText: string;
    try {
      const serialized = serializeForSummary(toSummarize);
      summaryText = await this.modelResolver.summarize(serialized, {
        systemPrompt: COMPACTION_SYSTEM_PROMPT,
        timeoutMs: COMPACTION_SUMMARIZE_TIMEOUT_MS,
        maxTokens: COMPACTION_SUMMARY_MAX_TOKENS,
      });
    } catch (err) {
      this.emitter.emit(SESSION_WS_EVENTS.runCompactionError, {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new CompactionError("Summarize LLM call failed", err);
    }

    // 改写 checkpointer。removeIds 传「所有带 id 的消息」（摘要区 + 保留区）：
    // 摘要区删掉换摘要；保留区删掉后由 applyCompaction 按序重新 append 到摘要之后，
    // 实现 [system, summary, ...keep] 的目标顺序。系统提示词无 id，不在此列、自动留最前。
    try {
      await this.threadState.applyCompaction(sessionId, {
        removeIds: messages
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string"),
        summaryText,
        keep,
      });
    } catch (err) {
      this.emitter.emit(SESSION_WS_EVENTS.runCompactionError, {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new CompactionError("applyCompaction failed", err);
    }

    // 占位行（失败仅 log，不回滚）
    try {
      await this.sessionMessages.recordCompactionPlaceholder({
        id: `comp-${randomUUID()}`,
        sessionId,
        summary: summaryText,
        removedCount: toSummarize.length,
        fromMessageId: toSummarize[0].id ?? "",
        toMessageId: toSummarize[toSummarize.length - 1].id ?? "",
      });
    } catch (err) {
      this.logger.warn(
        `recordCompactionPlaceholder failed; checkpointer 已正确，仅 UI 占位行丢失 session=${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // done
    this.emitter.emit(SESSION_WS_EVENTS.runCompactionDone, {
      sessionId,
      removedCount: toSummarize.length,
      summaryPreview: summaryText.slice(0, 200),
    });

    this.logger.log(
      `compaction done session=${sessionId} removed=${toSummarize.length} reason=${reason}`,
    );
    return { removedCount: toSummarize.length, summary: summaryText };
  }
}
