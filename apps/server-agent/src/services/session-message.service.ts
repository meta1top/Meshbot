import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { LessThan, Repository } from "typeorm";
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
  constructor(
    @InjectRepository(SessionMessage)
    private readonly repo: Repository<SessionMessage>,
  ) {}

  /**
   * 记录一条 user 消息。幂等：id 已存在视为成功，不覆盖原内容。
   * 单表写入，无需事务。
   *
   * 显式传 `createdAt: new Date()`（毫秒精度）—— 不依赖 DB 默认值的
   * `datetime('now')`（仅秒精度）。否则连发的 user 与 assistant 同秒会
   * 排序不稳定，导致 history 顺序错乱。
   */
  async recordUser(input: RecordUserInput): Promise<void> {
    const exists = await this.repo.findOneBy({ id: input.id });
    if (exists) return;
    await this.repo.insert({
      id: input.id,
      sessionId: input.sessionId,
      role: "user",
      content: input.content,
      reasoning: null,
      toolCalls: null,
      toolCallId: null,
      createdAt: new Date(),
    });
  }

  /**
   * 记录一条 assistant 消息（含可选 reasoning / toolCalls）。幂等。
   */
  async recordAssistant(input: RecordAssistantInput): Promise<void> {
    const exists = await this.repo.findOneBy({ id: input.id });
    if (exists) return;
    await this.repo.insert({
      id: input.id,
      sessionId: input.sessionId,
      role: "assistant",
      content: input.content,
      reasoning: input.reasoning,
      toolCalls: input.toolCalls ?? null,
      toolCallId: null,
      createdAt: new Date(),
    });
  }

  /**
   * 记录一条 role=tool 消息（tool 调用结果）。幂等（id = toolCallId）。
   */
  async recordToolResult(input: RecordToolResultInput): Promise<void> {
    const exists = await this.repo.findOneBy({ id: input.id });
    if (exists) return;
    await this.repo.insert({
      id: input.id,
      sessionId: input.sessionId,
      role: "tool",
      content: input.content,
      reasoning: null,
      toolCalls: null,
      toolCallId: input.toolCallId,
      createdAt: new Date(),
    });
  }

  /**
   * Cursor 分页：返回 sessionId 下早于 beforeMessageId 的最新 limit 条
   * （按 createdAt asc 排，前端按时间顺序展示）。
   *
   * 实现：先按 id 拿 before 锚点的 createdAt（若 before 给了），再
   * `WHERE sessionId AND createdAt < anchor ORDER BY createdAt DESC LIMIT (limit + 1)`，
   * 取 limit 条 + 用 limit+1 条判 hasMore。最后把数组 reverse 回 asc。
   */
  async listPage(
    sessionId: string,
    opts: { before?: string; limit: number },
  ): Promise<SessionMessagePage> {
    let anchorDate: Date | undefined;
    if (opts.before) {
      const anchor = await this.repo.findOneBy({ id: opts.before });
      if (!anchor || anchor.sessionId !== sessionId) {
        // 防越权：不属于该 session 的 id 一律 404，不暴露存在性
        throw new NotFoundException(
          `SessionMessage ${opts.before} not found in session ${sessionId}`,
        );
      }
      anchorDate = anchor.createdAt;
    }
    const rows = await this.repo.find({
      where: {
        sessionId,
        ...(anchorDate ? { createdAt: LessThan(anchorDate) } : {}),
      },
      // id 作 tie-breaker：同 createdAt（旧数据秒精度同秒、新数据毫秒精度极少
      // 同毫秒）时保证稳定排序，避免不同请求顺序不一致
      order: { createdAt: "DESC", id: "DESC" },
      take: opts.limit + 1,
    });
    const hasMore = rows.length > opts.limit;
    let slice = hasMore ? rows.slice(0, opts.limit) : rows;
    // reverse 回 asc（前端按时间顺序展示）
    slice.reverse();

    // Round up：把 slice 末尾紧跟着的 role=tool 行（如果有）一并捞回，
    // 避免 assistant 与其 tool result 被切到不同页。
    if (slice.length > 0) {
      const lastInSlice = slice[slice.length - 1];
      const qb = this.repo
        .createQueryBuilder("m")
        .where("m.session_id = :sessionId", { sessionId })
        .andWhere("m.created_at > :cutoff", { cutoff: lastInSlice.createdAt })
        .andWhere("m.role = :role", { role: "tool" })
        .orderBy("m.created_at", "ASC")
        .addOrderBy("m.id", "ASC");
      if (anchorDate) {
        qb.andWhere("m.created_at < :anchor", { anchor: anchorDate });
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
}
