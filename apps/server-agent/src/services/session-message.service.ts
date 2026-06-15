import { AccountContextService } from "@meshbot/agent";
import type { HeatmapCell } from "@meshbot/types-agent";
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, LessThan, MoreThan, Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { SessionMessage } from "../entities/session-message.entity";

/** 写 user 消息入参。 */
export interface RecordUserInput {
  id: string;
  sessionId: string;
  content: string;
}

/** 写 assistant 消息入参（含 reasoning）。 */
export interface RecordAssistantInput {
  id: string;
  sessionId: string;
  content: string;
  reasoning: string | null;
  /** 序列化好的 tool_calls JSON 字符串（assistant 调工具时）。 */
  toolCalls?: string | null;
}

/** 写 tool 结果入参。id = toolCallId 保证幂等 + 与 LangChain ToolMessage 一致。 */
export interface RecordToolResultInput {
  id: string;
  sessionId: string;
  toolCallId: string;
  content: string;
  /**
   * 工具是否成功执行（Zod 校验通过 + execute 未抛异常）。
   * 默认 true 兼容老调用方；为 false 时写入 metadata={ok:false}，给 history
   * 回放和前端「红色失败」复原状态用——否则刷新页面失败 tool 会显示成功色。
   */
  ok?: boolean;
}

/** 写 compaction 占位行入参。id 调用方自行生成（建议 `comp-${uuid}` 或时间戳）。 */
export interface RecordCompactionPlaceholderInput {
  id: string;
  sessionId: string;
  summary: string;
  removedCount: number;
  fromMessageId: string;
  toMessageId: string;
}

/** listPage 返回。 */
export interface SessionMessagePage {
  messages: SessionMessage[];
  hasMore: boolean;
}

/**
 * session_messages 表的归属 Service —— 展示反面 / 永不删。
 *
 * Runner 在 emit run.human / run.done 同时双写到此表（fire-and-forget）。
 * history 端点从此表读取并 cursor 分页，与 LangGraph checkpointer 解耦：未来
 * LLM context 被 summarize 压缩时，展示历史不受影响。
 */
@Injectable()
export class SessionMessageService {
  /** SessionMessage 账号作用域仓库（自动按当前账号过滤/盖章）。 */
  private readonly repo: ScopedRepository<SessionMessage>;
  /** 当前账号上下文：insertWithSeq 手工盖章 cloud_user_id 用。 */
  private readonly account: AccountContextService;

  constructor(
    @InjectRepository(SessionMessage)
    rawRepo: Repository<SessionMessage>,
    scopedFactory: ScopedRepositoryFactory,
    accountContext: AccountContextService,
  ) {
    this.repo = scopedFactory.create(rawRepo);
    this.account = accountContext;
  }

  /**
   * 统一插入入口：`seq` 由单条原子 INSERT 子查询 `(SELECT MAX(seq)+1 …)` 赋值，
   * 与本次 INSERT 同语句、在 SQLite 写锁内串行执行 —— 跨并发写者（流循环的
   * user/assistant、@OnEvent 的 tool result、压缩占位）唯一不碰撞。
   *
   * 调用方负责幂等检查（findOneBy）。入参不含 seq / createdAt：
   * createdAt 用 `datetime('now')`（秒精度即可，排序已不依赖它）。
   */
  private async insertWithSeq(
    row: Omit<Partial<SessionMessage>, "seq" | "createdAt" | "cloudUserId">,
  ): Promise<void> {
    // 当前账号：手工盖到新行 + 把 seq 子查询限定在「同账号同会话」内，
    // 既保证 seq 按账号独立计数，又杜绝子查询读到他账号的 MAX(seq)。
    const acct = this.account.getOrThrow();
    // ScopedRepository 不暴露 insert（无法自动盖账号），故走裸 QueryBuilder
    // 手工盖 cloudUserId 到 values + seq 子查询 WHERE，账号过滤在此显式补齐。
    // scope-check: allow-unscoped
    await this.repo
      .unscoped()
      .createQueryBuilder()
      .insert()
      .into(SessionMessage)
      .values({
        ...row,
        cloudUserId: acct,
        createdAt: () => "datetime('now')",
        seq: () =>
          "(SELECT COALESCE(MAX(seq), 0) + 1 FROM session_messages WHERE session_id = :sid AND cloud_user_id = :acct)",
      })
      .setParameter("sid", row.sessionId)
      .setParameter("acct", acct)
      .execute();
  }

  /**
   * 记录一条 user 消息。幂等：id 已存在视为成功，不覆盖原内容。
   * 单表写入，无需事务。seq 由 insertWithSeq 原子赋值。
   */
  async recordUser(input: RecordUserInput): Promise<void> {
    const exists = await this.repo.findOneBy({ id: input.id });
    if (exists) return;
    await this.insertWithSeq({
      id: input.id,
      sessionId: input.sessionId,
      role: "user",
      content: input.content,
      reasoning: null,
      toolCalls: null,
      toolCallId: null,
    });
  }

  /**
   * 记录一条 assistant 消息（含可选 reasoning / toolCalls）。幂等。
   */
  async recordAssistant(input: RecordAssistantInput): Promise<void> {
    const exists = await this.repo.findOneBy({ id: input.id });
    if (exists) return;
    await this.insertWithSeq({
      id: input.id,
      sessionId: input.sessionId,
      role: "assistant",
      content: input.content,
      reasoning: input.reasoning,
      toolCalls: input.toolCalls ?? null,
      toolCallId: null,
    });
  }

  /**
   * 记录一条 role=tool 消息（tool 调用结果）。幂等（id = toolCallId）。
   *
   * 失败时（input.ok === false）metadata 写 `{ ok: false }`；成功时 metadata
   * 保持 null（缺省即成功，老数据无 metadata 也按 ok 解释）。role=tool 行的
   * metadata 用途单一（仅本字段），无需 kind 区分符。
   */
  async recordToolResult(input: RecordToolResultInput): Promise<void> {
    const exists = await this.repo.findOneBy({ id: input.id });
    if (exists) return;
    const metadata = input.ok === false ? JSON.stringify({ ok: false }) : null;
    await this.insertWithSeq({
      id: input.id,
      sessionId: input.sessionId,
      role: "tool",
      content: input.content,
      reasoning: null,
      toolCalls: null,
      toolCallId: input.toolCallId,
      metadata,
    });
  }

  /**
   * 写一条 compaction 占位行（role=system，metadata 标 kind=compaction）。
   * 幂等：同 id 已存在直接返回。
   *
   * UI 在 message-list 渲染时识别 metadata.kind === "compaction" 走折叠组件，
   * 不当普通系统消息显示。
   */
  async recordCompactionPlaceholder(
    input: RecordCompactionPlaceholderInput,
  ): Promise<void> {
    const exists = await this.repo.findOneBy({ id: input.id });
    if (exists) return;
    await this.insertWithSeq({
      id: input.id,
      sessionId: input.sessionId,
      role: "system",
      content: input.summary,
      reasoning: null,
      toolCalls: null,
      toolCallId: null,
      metadata: JSON.stringify({
        kind: "compaction",
        removedCount: input.removedCount,
        fromMessageId: input.fromMessageId,
        toMessageId: input.toMessageId,
      }),
    });
  }

  /**
   * Cursor 分页：返回 sessionId 下早于 beforeMessageId 的最新 limit 条
   * （按 seq asc 排，前端按时间顺序展示）。
   *
   * 实现：先按 id 拿 before 锚点的 seq（若 before 给了），再
   * `WHERE sessionId AND seq < anchorSeq ORDER BY seq DESC LIMIT (limit + 1)`，
   * 取 limit 条 + 用 limit+1 条判 hasMore。最后把数组 reverse 回 asc。
   * cursor 对外仍是 messageId，内部 resolve 成 seq —— API 契约不变。
   */
  async listPage(
    sessionId: string,
    opts: { before?: string; limit: number },
  ): Promise<SessionMessagePage> {
    let anchorSeq: number | undefined;
    if (opts.before) {
      const anchor = await this.repo.findOneBy({ id: opts.before });
      if (!anchor || anchor.sessionId !== sessionId) {
        // 防越权：不属于该 session 的 id 一律 404，不暴露存在性
        throw new NotFoundException(
          `SessionMessage ${opts.before} not found in session ${sessionId}`,
        );
      }
      anchorSeq = anchor.seq;
    }
    const rows = await this.repo.find({
      where: {
        sessionId,
        ...(anchorSeq !== undefined ? { seq: LessThan(anchorSeq) } : {}),
      },
      // seq 会话内单调递增唯一，稳定排序，不会同值碰撞
      order: { seq: "DESC" },
      take: opts.limit + 1,
    });
    const hasMore = rows.length > opts.limit;
    let slice = hasMore ? rows.slice(0, opts.limit) : rows;
    // reverse 回 asc（前端按时间顺序展示）
    slice.reverse();

    // Round up：把 slice 末尾紧跟着的 role=tool 行（如果有）一并捞回，
    // 避免 assistant 与其 tool result 被切到不同页。
    if (slice.length > 0) {
      const lastSeq = slice[slice.length - 1].seq;
      const qb = this.repo
        .scopedQueryBuilder("m")
        .andWhere("m.session_id = :sessionId", { sessionId })
        .andWhere("m.seq > :cutoff", { cutoff: lastSeq })
        .andWhere("m.role = :role", { role: "tool" })
        .orderBy("m.seq", "ASC");
      if (anchorSeq !== undefined) {
        qb.andWhere("m.seq < :anchor", { anchor: anchorSeq });
      }
      const trailingTools = await qb.getMany();
      slice = [...slice, ...trailingTools];
    }

    return { messages: slice, hasMore };
  }

  /** 删某会话全部 session_messages（仅 session 删除时调用）。 */
  async deleteBySession(sessionId: string): Promise<void> {
    await this.repo.delete({ sessionId });
  }

  /**
   * 在给定 id 集合中，返回确实存在于本会话 session_messages 的那部分（Set）。
   * 供 pending 展示判断「该 pending 消息是否已入历史」——已入库的 failed/processing
   * 由历史在正确 seq 位置展示，不必再被前端追加到末尾。
   */
  async existingIds(sessionId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.repo.find({
      where: { sessionId, id: In(ids) },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }

  /** 取一条消息，按 id 查；不存在抛 NotFoundException。 */
  async findByIdOrFail(messageId: string): Promise<SessionMessage> {
    const row = await this.repo.findOneBy({ id: messageId });
    if (!row) {
      throw new NotFoundException(`SessionMessage ${messageId} not found`);
    }
    return row;
  }

  /**
   * 删某会话内 seq > cutoffSeq 的所有消息。供「重生成」剪 history 用。
   * cutoffSeq 本身保留（严格 >，不是 >=）。
   */
  async deleteAfter(sessionId: string, cutoffSeq: number): Promise<void> {
    await this.repo.delete({
      sessionId,
      seq: MoreThan(cutoffSeq),
    });
  }

  /**
   * 范围内消息活跃度聚合：总数 + 按本地日分桶（热力图/活跃天/连续天数来源）
   * + 按本地小时分桶（高峰时段来源）。since 为 null 表示全部。
   */
  async activitySince(
    since: Date | null,
  ): Promise<{ total: number; byDate: HeatmapCell[]; byHour: number[] }> {
    const base = () => {
      const qb = this.repo.scopedQueryBuilder("m");
      if (since) {
        qb.andWhere("datetime(m.created_at) >= datetime(:since)", {
          since: since.toISOString(),
        });
      }
      return qb;
    };
    const total = await base().getCount();
    const dayRows = await base()
      .select("strftime('%Y-%m-%d', m.created_at, 'localtime')", "date")
      .addSelect("COUNT(*)", "count")
      .groupBy("date")
      .orderBy("date", "ASC")
      .getRawMany<{ date: string; count: number | string }>();
    const byDate: HeatmapCell[] = dayRows.map((r) => ({
      date: r.date,
      count: Number(r.count),
    }));
    const hourRows = await base()
      .select(
        "CAST(strftime('%H', m.created_at, 'localtime') AS INTEGER)",
        "hour",
      )
      .addSelect("COUNT(*)", "count")
      .groupBy("hour")
      .getRawMany<{ hour: number | string; count: number | string }>();
    const byHour = Array.from({ length: 24 }, () => 0);
    for (const r of hourRows) byHour[Number(r.hour)] = Number(r.count);
    return { total, byDate, byHour };
  }

  /**
   * 设置 assistant 消息反馈。feedback=null 清空。
   * 校验 messageId 属于 sessionId（否则 NotFound）。metadata 单表 update。
   */
  async setFeedback(
    sessionId: string,
    messageId: string,
    feedback: "up" | "down" | null,
  ): Promise<void> {
    const row = await this.repo.findOneBy({ id: messageId });
    if (!row || row.sessionId !== sessionId) {
      throw new NotFoundException(
        `SessionMessage ${messageId} not found in session ${sessionId}`,
      );
    }
    await this.repo.update(
      { id: messageId },
      { metadata: feedback ? JSON.stringify({ feedback }) : null },
    );
  }
}
