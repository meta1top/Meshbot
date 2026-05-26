import { GraphService, COMPACTION_SYSTEM_PROMPT } from "@meshbot/agent";
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
const COMPACTION_SUMMARY_MAX_TOKENS = 600;
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
    private readonly graph: GraphService,
    private readonly modelConfig: ModelConfigService,
    private readonly sessionMessages: SessionMessageService,
    private readonly llmCalls: LlmCallService, // v1 未直接用，预留 v2 标记 purpose 用
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
    const messages = await this.graph.getMessagesSnapshot(sessionId);

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

    // 发 start 事件
    this.emitter.emit(SESSION_WS_EVENTS.runCompactionStart, {
      sessionId,
      reason,
    });

    let summaryText: string;
    try {
      const serialized = serializeForSummary(toSummarize);
      summaryText = await this.graph.summarize(serialized, {
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

    // 改写 checkpointer
    try {
      await this.graph.applyCompaction(sessionId, {
        removeIds: toSummarize
          .map((m) => m.id)
          .filter((id): id is string => typeof id === "string"),
        summaryText,
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
