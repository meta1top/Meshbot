import { Transactional } from "@meshbot/common";
import type {
  AppendMessageInput,
  CreateSessionInput,
  SessionStatus,
  SessionSummary,
} from "@meshbot/types-agent";
import { GraphService } from "@meshbot/agent";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { PendingMessage } from "../entities/pending-message.entity";
import { Session } from "../entities/session.entity";
import { CheckpointerCleanupService } from "./checkpointer-cleanup.service";
import { LlmCallService } from "./llm-call.service";
import { ScheduleService } from "./schedule.service";
import { SessionMessageService } from "./session-message.service";

const TITLE_MAX = 30;

/** Session entity → SessionSummary（Date → ISO，pinned 派生）。 */
function toSummary(s: Session): SessionSummary {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    pinned: s.pinnedAt !== null,
    pinnedAt: s.pinnedAt ? s.pinnedAt.toISOString() : null,
    titleGenerated: s.titleGenerated,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/** 会话与待处理用户消息的归属 Service。 */
@Injectable()
export class SessionService {
  constructor(
    @InjectRepository(Session)
    private readonly sessionRepo: Repository<Session>,
    @InjectRepository(PendingMessage)
    private readonly pendingRepo: Repository<PendingMessage>,
    private readonly llmCalls: LlmCallService,
    private readonly sessionMessages: SessionMessageService,
    private readonly checkpointer: CheckpointerCleanupService,
    private readonly graph: GraphService,
    private readonly schedules: ScheduleService,
  ) {}

  /**
   * 创建会话：建 Session(running) + 写首条 pending 消息。
   * 跨两表写入 —— 用 @Transactional 包裹的私有方法。
   */
  async createSession(
    input: CreateSessionInput,
  ): Promise<{ sessionId: string; session: SessionSummary }> {
    return this.createSessionInTx(input);
  }

  @Transactional()
  private async createSessionInTx(
    input: CreateSessionInput,
  ): Promise<{ sessionId: string; session: SessionSummary }> {
    const saved = await this.sessionRepo.save(
      this.sessionRepo.create({
        title: input.content.slice(0, TITLE_MAX),
        status: "running",
      }),
    );
    await this.pendingRepo.save(
      this.pendingRepo.create({
        sessionId: saved.id,
        content: input.content,
        status: "pending",
      }),
    );
    return { sessionId: saved.id, session: toSummary(saved) };
  }

  /**
   * 向已存在会话追加一条 pending 消息。messageId 由调用方生成（前端 UUID）：
   * 让前端乐观插入 user 气泡时就拿到最终 id，避免 run.human 早于 200 返回时
   * 找不到目标气泡。单表写入，无需事务。
   */
  async appendMessage(
    sessionId: string,
    input: AppendMessageInput,
  ): Promise<{ messageId: string; queued: boolean }> {
    const session = await this.findSessionOrFail(sessionId);
    const msg = await this.pendingRepo.save(
      this.pendingRepo.create({
        id: input.messageId,
        sessionId,
        content: input.content,
        status: "pending",
      }),
    );
    return { messageId: msg.id, queued: session.status === "running" };
  }

  /**
   * 删除一条 pending 消息。仅 status=pending 可删，其余状态返 Conflict。
   * 单表读+删；用 WHERE id+sessionId+status='pending' 三件套保证原子，防止
   * 「读到 pending → delete 之间 runner claim」窗口。
   *
   * 返回原 content，让前端在「编辑」场景回填输入框。
   */
  async deletePendingMessage(
    sessionId: string,
    messageId: string,
  ): Promise<{ content: string }> {
    const row = await this.pendingRepo.findOneBy({ id: messageId, sessionId });
    if (!row) {
      throw new NotFoundException(`PendingMessage ${messageId} not found`);
    }
    if (row.status !== "pending") {
      throw new ConflictException(
        `PendingMessage ${messageId} 已处于 ${row.status} 状态，无法删除`,
      );
    }
    const res = await this.pendingRepo.delete({
      id: messageId,
      sessionId,
      status: "pending",
    });
    if (!res.affected) {
      throw new ConflictException(
        `PendingMessage ${messageId} 已开始处理，无法删除`,
      );
    }
    return { content: row.content };
  }

  /** 找会话，不存在返 null（不抛）。 */
  findOrNull(sessionId: string): Promise<Session | null> {
    return this.sessionRepo.findOneBy({ id: sessionId });
  }

  /** 取会话，不存在抛 404。 */
  async findSessionOrFail(sessionId: string): Promise<Session> {
    const s = await this.sessionRepo.findOneBy({ id: sessionId });
    if (!s) throw new NotFoundException(`Session ${sessionId} not found`);
    return s;
  }

  /** 列出会话下排队/处理/失败中的消息，按时间升序。 */
  listActivePending(sessionId: string): Promise<PendingMessage[]> {
    return this.pendingRepo.find({
      where: [
        { sessionId, status: "pending" },
        { sessionId, status: "processing" },
        { sessionId, status: "failed" },
      ],
      order: { createdAt: "ASC" },
    });
  }

  /**
   * 取会话全部 failed 消息，整批转 processing 后返回（用于重试）。
   * 这些消息的 HumanMessage 已在 checkpointer，重试只重跑产出回复。
   */
  async claimFailed(sessionId: string): Promise<PendingMessage[]> {
    const rows = await this.pendingRepo.find({
      where: { sessionId, status: "failed" },
      order: { createdAt: "ASC" },
    });
    if (rows.length === 0) return [];
    await this.pendingRepo.update(
      { id: In(rows.map((r) => r.id)) },
      { status: "processing" },
    );
    return rows.map((r) => ({ ...r, status: "processing" as const }));
  }

  /**
   * 取会话全部 pending 消息，整批转 processing 后返回。
   * 单表 update，无需事务。
   */
  async claimPending(sessionId: string): Promise<PendingMessage[]> {
    const rows = await this.pendingRepo.find({
      where: { sessionId, status: "pending" },
      order: { createdAt: "ASC" },
    });
    if (rows.length === 0) return [];
    await this.pendingRepo.update(
      { id: In(rows.map((r) => r.id)) },
      { status: "processing" },
    );
    return rows.map((r) => ({ ...r, status: "processing" as const }));
  }

  /** 把一批消息标记为 failed（run 出错时调用；HumanMessage 已在 checkpointer）。 */
  async markFailed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pendingRepo.update({ id: In(ids) }, { status: "failed" });
  }

  /** 把一批消息标记为 processed，写 processed_at。 */
  async markProcessed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pendingRepo.update(
      { id: In(ids) },
      { status: "processed", processedAt: new Date() },
    );
  }

  /**
   * 把一批 processing 消息退回 pending。
   * （当前无生产调用方，保留备用；run 出错改用 markFailed）
   */
  async rollbackToPending(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pendingRepo.update({ id: In(ids) }, { status: "pending" });
  }

  /**
   * 启动恢复：把所有遗留的 processing 消息退回 pending。
   * 进程重启时 inflight 内存丢失，让这些消息可被重新消费。
   */
  async rollbackProcessingToPending(): Promise<number> {
    const res = await this.pendingRepo.update(
      { status: "processing" },
      { status: "pending" },
    );
    return res.affected ?? 0;
  }

  /** 更新会话 status（idle / running）。 */
  async setStatus(sessionId: string, status: SessionStatus): Promise<void> {
    await this.sessionRepo.update({ id: sessionId }, { status });
  }

  /**
   * 列出全部会话，按「固定优先 / 固定组按 pinnedAt desc / 其余按 updatedAt desc」
   * 排序。客户端 sortSessions 与之等价。
   *
   * id desc 作 tie-breaker（避免同毫秒漂移）。当前 dev 量级一次性全取，未来上
   * 千再加分页。
   */
  async listAllSorted(): Promise<SessionSummary[]> {
    const rows = await this.sessionRepo
      .createQueryBuilder("s")
      .orderBy("CASE WHEN s.pinned_at IS NULL THEN 1 ELSE 0 END", "ASC")
      .addOrderBy("s.pinned_at", "DESC")
      .addOrderBy("s.updated_at", "DESC")
      .addOrderBy("s.id", "DESC")
      .getMany();
    return rows.map(toSummary);
  }

  /**
   * 更新会话 title / pinned。至少传一项（Zod 在控制器 DTO 层已保证）。
   * pinned: true → 写当前时间到 pinned_at；pinned: false → null。
   * 单表 update，无需事务。
   */
  async patch(
    sessionId: string,
    input: { title?: string; pinned?: boolean },
  ): Promise<SessionSummary> {
    const changes: Partial<Session> = {};
    if (input.title !== undefined) {
      changes.title = input.title;
      changes.titleGenerated = true;
    }
    if (input.pinned !== undefined) {
      changes.pinnedAt = input.pinned ? new Date() : null;
    }
    await this.sessionRepo.update({ id: sessionId }, changes);
    const s = await this.findSessionOrFail(sessionId);
    return toSummary(s);
  }

  /**
   * 仅在 titleGenerated 仍为 false 时把 title 写入并 mark generated=true。
   * 用户已手动改名时返回 null，调用方丢弃结果。单 update + WHERE 三件套
   * 保证原子，无需事务。
   *
   * 给 SessionTitleService 用 —— 防止 LLM 生成期间用户改名被覆盖。
   */
  async patchIfNotGenerated(
    sessionId: string,
    title: string,
  ): Promise<SessionSummary | null> {
    const res = await this.sessionRepo.update(
      { id: sessionId, titleGenerated: false },
      { title, titleGenerated: true },
    );
    if (!res.affected) return null;
    const s = await this.findSessionOrFail(sessionId);
    return toSummary(s);
  }

  /**
   * 级联删除整条会话：先确认存在抛 404，再事务内按顺序删
   * llm_calls / session_messages / pending_messages / sessions，
   * 事务外删 checkpointer 两张表（不在 TxTypeOrm 注册范围）。
   *
   * 这里没 interrupt inflight：在 controller 层处理（先 runner.interrupt 再调本方法），
   * 让 service 保持「纯数据层」。
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.findSessionOrFail(sessionId);
    await this.deleteSessionInTx(sessionId);
    await this.schedules.deleteBySession(sessionId);
    await this.checkpointer.deleteThread(sessionId);
  }

  @Transactional()
  private async deleteSessionInTx(sessionId: string): Promise<void> {
    await this.llmCalls.deleteBySession(sessionId);
    await this.sessionMessages.deleteBySession(sessionId);
    await this.pendingRepo.delete({ sessionId });
    await this.sessionRepo.delete({ id: sessionId });
  }

  /** 范围内创建的会话数。since 为 null 表示全部。 */
  async countCreatedSince(since: Date | null): Promise<number> {
    const qb = this.sessionRepo.createQueryBuilder("s");
    if (since) {
      qb.where("datetime(s.created_at) >= datetime(:since)", {
        since: since.toISOString(),
      });
    }
    return qb.getCount();
  }

  /**
   * 重生成入口：找到 user 消息后，删该消息后的所有 session_messages /
   * llm_calls / checkpointer state。cutoff user 消息本身保留，调用方接着
   * 调 runner.kickResume 触发 LLM 重跑。
   *
   * 不删 pending_messages：该 user 消息已 processed；pending 表是独立的
   * 入队队列，与 checkpointer state 解耦。
   */
  async regenerateAfter(sessionId: string, messageId: string): Promise<void> {
    await this.findSessionOrFail(sessionId);
    const msg = await this.sessionMessages.findByIdOrFail(messageId);
    if (msg.sessionId !== sessionId) {
      throw new NotFoundException(
        `SessionMessage ${messageId} not in session ${sessionId}`,
      );
    }
    if (msg.role !== "user") {
      throw new BadRequestException("仅 user 消息支持重生成");
    }
    // session_messages 按 seq 裁剪（唯一可靠排序键）；llm_calls 表无 seq，
    // 但 assistant 调用天然晚于该 user 消息，createdAt 裁剪正确。
    await this.sessionMessages.deleteAfter(sessionId, msg.seq);
    await this.llmCalls.deleteAfter(sessionId, msg.createdAt);
    await this.graph.cutMessagesAfter(sessionId, messageId);
  }
}
