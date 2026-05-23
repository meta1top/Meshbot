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
    });
  }

  /**
   * 记录一条 assistant 消息（含可选 reasoning）。幂等。
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
      toolCalls: null,
      toolCallId: null,
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
      order: { createdAt: "DESC" },
      take: opts.limit + 1,
    });
    const hasMore = rows.length > opts.limit;
    const slice = hasMore ? rows.slice(0, opts.limit) : rows;
    // reverse 回 asc（前端按时间顺序展示）
    slice.reverse();
    return { messages: slice, hasMore };
  }
}
