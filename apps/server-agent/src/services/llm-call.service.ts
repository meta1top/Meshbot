import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, MoreThan, Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { LlmCall } from "../entities/llm-call.entity";

/** LlmCallService.record 入参 —— 单次 LLM 调用的完整观测数据。 */
export interface RecordLlmCallInput {
  sessionId: string;
  messageId: string;
  providerType: string;
  model: string;
  /** 模型配置显示名快照（无名字的旁路径可缺省，落 NULL）。 */
  modelName?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  durationMs: number;
}

/** getSessionTotals 返回的会话累计（与 types-agent 的 SessionTotals 同形）。 */
export interface SessionTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  callCount: number;
  /** 最近一次 LLM 调用的 input_tokens；空 session = 0。 */
  lastInputTokens: number;
}

/** LlmCall 表的归属 Service —— LLM 调用观测的数据层。 */
@Injectable()
export class LlmCallService {
  /** LlmCall 账号作用域仓库（自动按当前账号过滤/盖章）。 */
  private readonly llmCallRepo: ScopedRepository<LlmCall>;

  constructor(
    @InjectRepository(LlmCall)
    rawRepo: Repository<LlmCall>,
    scopedFactory: ScopedRepositoryFactory,
  ) {
    this.llmCallRepo = scopedFactory.create(rawRepo);
  }

  /**
   * 落一条 LLM 调用记录。
   *
   * 显式传 `createdAt: new Date()`（毫秒精度）—— 不依赖 @CreateDateColumn
   * 默认的 CURRENT_TIMESTAMP（仅秒精度）。同秒多条会被 deleteAfter 的
   * MoreThan 漏剪，而 user 与 assistant 间隔常常小于 1s。
   */
  async record(input: RecordLlmCallInput): Promise<void> {
    await this.llmCallRepo.save({ ...input, createdAt: new Date() });
  }

  /** 列出某会话的全部 LLM 调用，按 createdAt 升序。 */
  listBySession(sessionId: string): Promise<LlmCall[]> {
    return this.llmCallRepo.find({
      where: { sessionId },
      order: { createdAt: "ASC" },
    });
  }

  /** 会话累计 —— 各 token 字段 SUM + callCount + lastInputTokens。 */
  async getSessionTotals(sessionId: string): Promise<SessionTotals> {
    const rows = await this.llmCallRepo.find({
      where: { sessionId },
      order: { createdAt: "ASC" },
    });
    const base = rows.reduce(
      (acc, r) => ({
        inputTokens: acc.inputTokens + r.inputTokens,
        outputTokens: acc.outputTokens + r.outputTokens,
        totalTokens: acc.totalTokens + r.totalTokens,
        cacheReadTokens: acc.cacheReadTokens + r.cacheReadTokens,
        cacheCreationTokens: acc.cacheCreationTokens + r.cacheCreationTokens,
        reasoningTokens: acc.reasoningTokens + r.reasoningTokens,
        callCount: acc.callCount + 1,
      }),
      {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        callCount: 0,
      },
    );
    return {
      ...base,
      lastInputTokens: rows.at(-1)?.inputTokens ?? 0,
    };
  }

  /**
   * 按 messageId 批量查 LlmCall（用于历史分页本批的 byMessage 投影）。
   * 空数组直接返 []，不打数据库。
   */
  async listByMessageIds(messageIds: string[]): Promise<LlmCall[]> {
    if (messageIds.length === 0) return [];
    return this.llmCallRepo.find({
      where: { messageId: In(messageIds) },
    });
  }

  /** 删某会话全部 LLM 调用观测（仅 session 删除时调用）。 */
  async deleteBySession(sessionId: string): Promise<void> {
    await this.llmCallRepo.delete({ sessionId });
  }

  /** 删某会话内 createdAt > cutoff 的所有 LLM 调用记录。供「重生成」剪 usage 用。 */
  async deleteAfter(sessionId: string, cutoff: Date): Promise<void> {
    await this.llmCallRepo.delete({
      sessionId,
      createdAt: MoreThan(cutoff),
    });
  }

  /** 拿某会话最新一行 LlmCall（按 createdAt 倒序取 1）。供 ContextCompactor pre-check 用。 */
  async getLastBySession(sessionId: string): Promise<LlmCall | null> {
    const row = await this.llmCallRepo.findOne({
      where: { sessionId },
      order: { createdAt: "DESC" },
    });
    return row ?? null;
  }

  /** 范围内 total_tokens 求和。since 为 null 表示全部。 */
  async sumTotalTokensSince(since: Date | null): Promise<number> {
    const qb = this.llmCallRepo
      .scopedQueryBuilder("c")
      .select("COALESCE(SUM(c.total_tokens), 0)", "sum");
    if (since) {
      qb.andWhere("datetime(c.created_at) >= datetime(:since)", {
        since: since.toISOString(),
      });
    }
    const row = await qb.getRawOne<{ sum: number | string }>();
    return Number(row?.sum ?? 0);
  }

  /** 范围内出现次数最多的 model；无记录返回 null。 */
  async topModelSince(since: Date | null): Promise<string | null> {
    const qb = this.llmCallRepo
      .scopedQueryBuilder("c")
      .select("c.model", "model")
      .addSelect("COUNT(*)", "count")
      .groupBy("c.model")
      .orderBy("count", "DESC")
      .limit(1);
    if (since) {
      qb.andWhere("datetime(c.created_at) >= datetime(:since)", {
        since: since.toISOString(),
      });
    }
    const row = await qb.getRawOne<{ model: string; count: number | string }>();
    return row?.model ?? null;
  }
}
