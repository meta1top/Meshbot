import { Transactional } from "@meshbot/common";
import type {
  AppendMessageInput,
  CreateSessionInput,
  SessionStatus,
  SessionSummary,
} from "@meshbot/types-agent";
import { stripLlmuse } from "@meshbot/types-agent";
import { ThreadStateService } from "@meshbot/agent";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
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
  /** Session 账号作用域仓库（自动按当前账号过滤/盖章）。 */
  private readonly sessionRepo: ScopedRepository<Session>;
  /** PendingMessage 账号作用域仓库（自动按当前账号过滤/盖章）。 */
  private readonly pendingRepo: ScopedRepository<PendingMessage>;

  /**
   * 裸 Session 仓库：仅供 @Transactional() 的 findDataSource 反射遍历 service
   * 字段定位 DataSource（作用域仓库不是 Repository 实例，取不到 DataSource），
   * 业务读写一律走 sessionRepo / pendingRepo 作用域仓库。
   */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: findDataSource 反射读取
  private readonly txAnchorRepo: Repository<Session>;

  constructor(
    @InjectRepository(Session) rawSessionRepo: Repository<Session>,
    @InjectRepository(PendingMessage)
    rawPendingRepo: Repository<PendingMessage>,
    scopedFactory: ScopedRepositoryFactory,
    private readonly llmCalls: LlmCallService,
    private readonly sessionMessages: SessionMessageService,
    private readonly checkpointer: CheckpointerCleanupService,
    private readonly threadState: ThreadStateService,
    private readonly schedules: ScheduleService,
  ) {
    // 包裹 tx-aware 注入代理：作用域仓库的操作仍参与外层 @Transactional 边界
    this.sessionRepo = scopedFactory.create(rawSessionRepo);
    this.pendingRepo = scopedFactory.create(rawPendingRepo);
    this.txAnchorRepo = rawSessionRepo;
  }

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
    const saved = (await this.sessionRepo.save({
      title: stripLlmuse(input.content).slice(0, TITLE_MAX),
      status: "running" as const,
      kind: input.kind ?? "user",
    })) as Session;
    await this.pendingRepo.save({
      sessionId: saved.id,
      content: input.content,
      status: "pending" as const,
    });
    return { sessionId: saved.id, session: toSummary(saved) };
  }

  /**
   * 建子 Agent 子会话：Session(kind:"subagent" + parent 关联, running) + 首条 pending(task)。
   * 跨两表写入，@Transactional 包裹。须在父 run 账号上下文内调用（作用域仓库自动盖 cloudUserId）。
   */
  async createSubSession(input: {
    parentSessionId: string;
    parentToolCallId: string;
    task: string;
    description?: string;
  }): Promise<{ subSessionId: string }> {
    return this.createSubSessionInTx(input);
  }

  @Transactional()
  private async createSubSessionInTx(input: {
    parentSessionId: string;
    parentToolCallId: string;
    task: string;
    description?: string;
  }): Promise<{ subSessionId: string }> {
    const title = (input.description ?? stripLlmuse(input.task)).slice(
      0,
      TITLE_MAX,
    );
    const saved = (await this.sessionRepo.save({
      title,
      status: "running" as const,
      kind: "subagent" as const,
      parentSessionId: input.parentSessionId,
      parentToolCallId: input.parentToolCallId,
    })) as Session;
    await this.pendingRepo.save({
      sessionId: saved.id,
      content: input.task,
      status: "pending" as const,
    });
    return { subSessionId: saved.id };
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
    const msg = await this.pendingRepo.save({
      id: input.messageId,
      sessionId,
      content: input.content,
      status: "pending" as const,
    });
    return {
      messageId: msg.id as string,
      queued: session.status === "running",
    };
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

  /**
   * 列出某父会话派生的全部子会话（id + 认领用的 parentToolCallId）。
   * 供 history 组装嵌套卡关联：子 run 进行中工具结果未落库，前端刷新后唯有
   * 此路能把 dispatch 工具卡认领到子会话。
   */
  listChildren(
    parentSessionId: string,
  ): Promise<Array<Pick<Session, "id" | "parentToolCallId">>> {
    return this.sessionRepo.find({
      where: { parentSessionId },
      select: { id: true, parentToolCallId: true },
    });
  }

  /** 按 session 反查其归属账号（系统级，无账号上下文时用，如 runner/cron 建上下文）。 */
  async findOwner(sessionId: string): Promise<string | null> {
    // scope-check: allow-unscoped
    const row = await this.sessionRepo.unscoped().findOne({
      where: { id: sessionId },
      select: { id: true, cloudUserId: true },
    });
    return row?.cloudUserId ?? null;
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
   * 供 pending 展示端点：在 listActivePending 基础上标注每条是否已入 session_messages。
   * 前端据 inHistory 区分——已入库的 failed/processing 由历史在正确 seq 位置渲染，
   * 不再追加到时间线末尾；未入库的（孤儿）才追加。单读，无需事务。
   */
  async listActivePendingWithHistory(
    sessionId: string,
  ): Promise<Array<PendingMessage & { inHistory: boolean }>> {
    const rows = await this.listActivePending(sessionId);
    const existing = await this.sessionMessages.existingIds(
      sessionId,
      rows.map((r) => r.id),
    );
    return rows.map(
      (r) =>
        ({ ...r, inHistory: existing.has(r.id) }) as PendingMessage & {
          inHistory: boolean;
        },
    );
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
    return rows.map(
      (r) => ({ ...r, status: "processing" as const }) as PendingMessage,
    );
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
    return rows.map(
      (r) => ({ ...r, status: "processing" as const }) as PendingMessage,
    );
  }

  /** 把一批消息标记为 failed（run 出错时调用；HumanMessage 已在 checkpointer）。 */
  async markFailed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pendingRepo.update({ id: In(ids) }, { status: "failed" });
  }

  /**
   * 会话下是否存在 failed 状态的 pending 消息。
   *
   * `RunnerService.kickAndWait` 会吞掉 `runOnce` 抛出的错误（log + break 后
   * 正常 resolve），调用方拿不到异常；但失败的批次已被 `markFailed` 落成
   * failed 状态，据此可判定该 session 的最近一次 run 是否失败。
   * 供 `DispatchSubagentService` 判断子会话 run 结果——单表读，无需事务。
   */
  async hasFailedPending(sessionId: string): Promise<boolean> {
    const count = await this.pendingRepo.count({
      where: { sessionId, status: "failed" },
    });
    return count > 0;
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
    // 启动时（RunnerService.onModuleInit）无账号上下文，作用域仓库会抛
    // NO_ACCOUNT_CONTEXT；这里跨账号全量重置遗留 processing 是正确语义，故走裸仓库。
    // scope-check: allow-unscoped
    const res = await this.pendingRepo
      .unscoped()
      .update({ status: "processing" }, { status: "pending" });
    return res.affected ?? 0;
  }

  /** 更新会话 status（idle / running）。 */
  async setStatus(sessionId: string, status: SessionStatus): Promise<void> {
    await this.sessionRepo.update({ id: sessionId }, { status });
  }

  /**
   * 列出全部会话，按「固定优先 / 固定组按 pinnedAt desc / 其余按 updatedAt desc」
   * 排序。仅返回 kind='user' 的普通会话（排除 quick 随手问临时会话）。
   *
   * id desc 作 tie-breaker（避免同毫秒漂移）。当前 dev 量级一次性全取，未来上
   * 千再加分页。
   *
   * 注意：scopedQueryBuilder("s") 已用 .where() 注入账号过滤；kind 过滤必须用
   * .andWhere()，否则会覆盖账号 where 条件导致账号隔离失效。
   */
  async listAllSorted(): Promise<SessionSummary[]> {
    const rows = await this.sessionRepo
      .scopedQueryBuilder("s")
      .andWhere("s.kind = :kind", { kind: "user" })
      .orderBy("CASE WHEN s.pinned_at IS NULL THEN 1 ELSE 0 END", "ASC")
      .addOrderBy("s.pinned_at", "DESC")
      .addOrderBy("s.updated_at", "DESC")
      .addOrderBy("s.id", "DESC")
      .getMany();
    return rows.map(toSummary);
  }

  /** 列出随手问临时会话（kind="quick"），按更新时间倒序——供随手问面板「历史」。 */
  async listQuickSessions(): Promise<SessionSummary[]> {
    const rows = await this.sessionRepo
      .scopedQueryBuilder("s")
      .andWhere("s.kind = :kind", { kind: "quick" })
      .orderBy("s.updated_at", "DESC")
      .addOrderBy("s.id", "DESC")
      .getMany();
    return rows.map(toSummary);
  }

  /** 把随手问临时会话沉淀为侧栏会话（kind: quick→user）。 */
  async promoteToSidebar(sessionId: string): Promise<SessionSummary> {
    await this.sessionRepo.update(
      { id: sessionId, kind: "quick" },
      { kind: "user" },
    );
    const s = await this.findSessionOrFail(sessionId);
    return toSummary(s);
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
    const qb = this.sessionRepo.scopedQueryBuilder("s");
    if (since) {
      qb.andWhere("datetime(s.created_at) >= datetime(:since)", {
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
    await this.threadState.cutMessagesAfter(
      sessionId,
      msg.langgraphId ?? messageId,
    );
  }
}
