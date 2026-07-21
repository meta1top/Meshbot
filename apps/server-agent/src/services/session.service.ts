import { Transactional } from "@meshbot/common";
import type {
  AppendMessageInput,
  CreateSessionInput,
  SessionCreatedEvent,
  SessionDeletedEvent,
  SessionRenamedEvent,
  SessionStatus,
  SessionSummary,
} from "@meshbot/types-agent";
import { SESSION_LIFECYCLE_EVENTS, stripLlmuse } from "@meshbot/types-agent";
import { ThreadStateService } from "@meshbot/lib-agent";
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { PendingMessage } from "../entities/pending-message.entity";
import { Session } from "../entities/session.entity";
import { CheckpointerCleanupService } from "./checkpointer-cleanup.service";
import { LlmCallService } from "./llm-call.service";
import { ModelConfigService } from "./model-config.service";
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
    modelConfigId: s.modelConfigId ?? null,
    agentId: s.agentId,
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
    private readonly modelConfigs: ModelConfigService,
    private readonly emitter: EventEmitter2,
  ) {
    // 包裹 tx-aware 注入代理：作用域仓库的操作仍参与外层 @Transactional 边界
    this.sessionRepo = scopedFactory.create(rawSessionRepo);
    this.pendingRepo = scopedFactory.create(rawPendingRepo);
    this.txAnchorRepo = rawSessionRepo;
  }

  /**
   * 创建会话：建 Session(running) + 写首条 pending 消息。
   * 跨两表写入 —— 用 @Transactional 包裹的私有方法。
   *
   * `agentId` 必填：会话归属的 Agent 决定人格/技能/MCP/记忆/工作区如何解析，调用方
   * （Controller / 远程 run 入站等）须自行给出真实来源，拿不到就调
   * `AgentService.ensureDefault()`——本方法不做兜底，杜绝空字符串静默落库。
   */
  async createSession(
    input: CreateSessionInput & { agentId: string },
  ): Promise<{ sessionId: string; session: SessionSummary }> {
    const created = await this.createSessionInTx(input);
    // 生命周期事件（统一契约，spec §A）：本地端经 ws/events 消费，远程 Agent 级
    // 观察者经 relay 镜像消费。发射点在 Service 而非 Controller——REST 建会话与
    // 远程 run 入站建会话两条路径自动共享，不留静默洞。（早先这里写的是「三条
    // 路径，含定时任务建会话」，是错的：`ScheduleExecutor.fire()` 只对已存在
    // 会话 appendMessage，全仓 `createSession` 调用点只有上述两处。）
    // 放在事务方法**之外**：事务未提交就通知，观察者回查会看不到这条会话。
    //
    // kind="quick"（随手问临时会话）不发：`listAllSorted`/`listByAgentSorted`
    // 都用 `kind='user'` 白名单过滤、不进侧栏，若照样 emit created，观察者
    // （本地侧栏 sessionsAtom / 远程 Agent 会话列表）会用 applySessionListEvent
    // 的「不认识就插入」语义把它凭空插进列表——与 kind="subagent"
    // （`createSubSession` 走另一方法、从不 emit created）是同一类坑，这里补
    // 上是因为 T13 设计统一事件契约时只排除了 subagent，漏看了 quick。
    if (input.kind !== "quick") {
      this.emitter.emit(SESSION_LIFECYCLE_EVENTS.created, {
        agentId: input.agentId,
        session: created.session,
      } satisfies SessionCreatedEvent);
    }
    return created;
  }

  @Transactional()
  private async createSessionInTx(
    input: CreateSessionInput & { agentId: string },
  ): Promise<{ sessionId: string; session: SessionSummary }> {
    const saved = (await this.sessionRepo.save({
      title: stripLlmuse(input.content).slice(0, TITLE_MAX),
      status: "running" as const,
      kind: input.kind ?? "user",
      agentId: input.agentId,
      // 会话级模型选择：runner 每次 run 经 ModelRunContext 读此列做 override。
      modelConfigId: input.modelConfigId ?? null,
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
   *
   * `agentId` 继承父会话——子 Agent 必须跑在同一个 Agent 的技能/工作区里，故不接受
   * 调用方传入，而是读父会话落库值（父会话必然存在且已有合法 agentId）。
   */
  async createSubSession(input: {
    parentSessionId: string;
    parentToolCallId: string;
    task: string;
    description?: string;
    background?: boolean;
    modelConfigId?: string | null;
  }): Promise<{ subSessionId: string }> {
    return this.createSubSessionInTx(input);
  }

  @Transactional()
  private async createSubSessionInTx(input: {
    parentSessionId: string;
    parentToolCallId: string;
    task: string;
    description?: string;
    background?: boolean;
    modelConfigId?: string | null;
  }): Promise<{ subSessionId: string }> {
    const parent = await this.findSessionOrFail(input.parentSessionId);
    const title = (input.description ?? stripLlmuse(input.task)).slice(
      0,
      TITLE_MAX,
    );
    const saved = (await this.sessionRepo.save({
      title,
      status: "running" as const,
      kind: "subagent" as const,
      agentId: parent.agentId,
      parentSessionId: input.parentSessionId,
      parentToolCallId: input.parentToolCallId,
      background: input.background ? 1 : 0,
      modelConfigId: input.modelConfigId ?? null,
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
   * 列出某 Agent 下的全部会话（不区分 kind）。供「删除 Agent」级联清理其全部
   * 会话使用——`agents.agent_id` 无数据库外键（项目禁止外键约束），删 Agent
   * 前必须先把归属它的会话一起清掉，否则会留下指向已删 Agent 的悬空引用。
   */
  findByAgentId(agentId: string): Promise<Session[]> {
    return this.sessionRepo.find({ where: { agentId } });
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

  /** 置/清「待了结后台子任务」标记（播报完成置 0）。 */
  async setBackground(sessionId: string, value: boolean): Promise<void> {
    await this.sessionRepo.update(
      { id: sessionId },
      { background: value ? 1 : 0 },
    );
  }

  /**
   * 系统级扫描：所有账号的「待了结后台子任务」（kind=subagent 且 background=1）。
   * 仅供进程启动恢复用——boot 时无账号上下文，须 unscoped 反查后逐个建上下文处理。
   */
  listPendingBackgroundSubagentsUnscoped(): Promise<
    Array<
      Pick<
        Session,
        "id" | "parentSessionId" | "parentToolCallId" | "title" | "cloudUserId"
      >
    >
  > {
    // scope-check: allow-unscoped
    return this.sessionRepo.unscoped().find({
      where: { kind: "subagent", background: 1 },
      select: {
        id: true,
        parentSessionId: true,
        parentToolCallId: true,
        title: true,
        cloudUserId: true,
      },
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

  /**
   * 按 session 反查其归属账号 + 归属 Agent（系统级，无账号上下文时用）。
   * 与 {@link findOwner} 同款窄投影查询（同一张表、同一个 sessionId、同一次
   * 索引查找），只多带一列 agentId——供 RunnerService 在建账号上下文的同时
   * 一并拿到 agentId，喂给 `session.status_changed` 事件，省掉一次专门为
   * agentId 而发的回查（见 setSessionStatus）。`findOwner` 本体不动，避免
   * 影响它的另一个调用方 session-title.service.ts。
   */
  async findOwnerAndAgent(
    sessionId: string,
  ): Promise<{ cloudUserId: string; agentId: string } | null> {
    // scope-check: allow-unscoped
    const row = await this.sessionRepo.unscoped().findOne({
      where: { id: sessionId },
      select: { id: true, cloudUserId: true, agentId: true },
    });
    if (!row) return null;
    return { cloudUserId: row.cloudUserId, agentId: row.agentId };
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

  /**
   * 启动时把遗留的 running 会话重置为 idle，返回受影响行数。
   *
   * 进程崩在 run 中间时 RunnerService 的 finally 没机会跑，status 会永久停在
   * running，侧栏「运行中」绿点冷启动后仍亮着且永不熄灭。
   */
  async resetRunningToIdle(): Promise<number> {
    // 启动时（RunnerService.onModuleInit）无账号上下文，作用域仓库会抛
    // NO_ACCOUNT_CONTEXT；本地轨单进程假设下跨账号全量重置是正确语义，故走裸仓库。
    // scope-check: allow-unscoped
    const res = await this.sessionRepo
      .unscoped()
      .update({ status: "running" }, { status: "idle" });
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
    const rows = await this.sortedUserSessionsQb().getMany();
    return rows.map(toSummary);
  }

  /**
   * 列出**某个 Agent 名下**的普通会话（kind='user'），排序规则与
   * {@link listAllSorted} 完全一致。
   *
   * 供跨设备查询通道（B 侧 `RemoteQueryInboundService`）使用：一设备多 Agent 下
   * 远端点开的是「设备上的某个 Agent」，会话列表必须按该 Agent 收窄——否则远端
   * 会看到同设备上别的 Agent 的会话（数据越界），点进去发消息又必然撞上远程 run
   * 的会话归属门控，报错原因还完全对不上。
   *
   * fail-closed：agentId 为空串/undefined 时直接返空列表，绝不退化成「列出全部」。
   */
  async listByAgentSorted(agentId: string): Promise<SessionSummary[]> {
    if (!agentId) return [];
    const rows = await this.sortedUserSessionsQb()
      .andWhere("s.agentId = :agentId", { agentId })
      .getMany();
    return rows.map(toSummary);
  }

  /**
   * 「固定优先 / 固定组按 pinnedAt desc / 其余按 updatedAt desc」的 kind='user'
   * 会话查询构造器，供 listAllSorted 与 listByAgentSorted 共用。
   */
  private sortedUserSessionsQb() {
    return this.sessionRepo
      .scopedQueryBuilder("s")
      .andWhere("s.kind = :kind", { kind: "user" })
      .orderBy("CASE WHEN s.pinned_at IS NULL THEN 1 ELSE 0 END", "ASC")
      .addOrderBy("s.pinned_at", "DESC")
      .addOrderBy("s.updated_at", "DESC")
      .addOrderBy("s.id", "DESC");
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

  /**
   * 把随手问临时会话沉淀为侧栏会话（kind: quick→user）。
   *
   * 提升成功后要发 `created`：`kind="quick"` 建会话时刻意**不发**（那类会话被
   * 侧栏的 `kind='user'` 白名单挡着，发了会被 `applySessionListEvent` 的
   * 「不认识就插入」语义凭空插进列表）。提升这一刻它才第一次成为侧栏成员，
   * 对全部观察者（本机其他标签页的 `sessionsAtom`、云端 Agent 级观察者）而言
   * 正是「之前不认识、现在该出现」——`created` 的插入语义完全适配，不需要
   * 发明新事件类型。
   *
   * 不发的话，只有触发提升的那个标签页能看到（它自己改了本地状态），其余
   * 观察者要等下次回源——这类只在多标签页/远程观察下才可见的不一致极难复现。
   */
  async promoteToSidebar(sessionId: string): Promise<SessionSummary> {
    const res = await this.sessionRepo.update(
      { id: sessionId, kind: "quick" },
      { kind: "user" },
    );
    const s = await this.findSessionOrFail(sessionId);
    // 仅在本次调用真的完成了 quick→user 转换时才发：重复调用（会话已是 user）
    // 的 affected 为 0，此时再发会让观察者收到一条它已经有的会话——虽然
    // `applySessionListEvent` 的 created 分支按 id 查重不会真的插重，但发一条
    // 语义上不成立的事件会污染排查现场。同 patchIfNotGenerated 的既有做法。
    if (res.affected) {
      this.emitter.emit(SESSION_LIFECYCLE_EVENTS.created, {
        agentId: s.agentId,
        session: toSummary(s),
      } satisfies SessionCreatedEvent);
    }
    return toSummary(s);
  }

  /**
   * 更新会话 title / pinned。至少传一项（Zod 在控制器 DTO 层已保证）。
   * pinned: true → 写当前时间到 pinned_at；pinned: false → null。
   * 单表 update，无需事务。
   */
  async patch(
    sessionId: string,
    input: { title?: string; pinned?: boolean; modelConfigId?: string },
  ): Promise<SessionSummary> {
    const changes: Partial<Session> = {};
    if (input.title !== undefined) {
      changes.title = input.title;
      changes.titleGenerated = true;
    }
    if (input.pinned !== undefined) {
      changes.pinnedAt = input.pinned ? new Date() : null;
    }
    if (input.modelConfigId !== undefined) {
      // 校验归属：按账号作用域查询，他账号/不存在的 id 统一 404，防越权指认。
      await this.modelConfigs.findOneOrFail(input.modelConfigId);
      changes.modelConfigId = input.modelConfigId;
    }
    await this.sessionRepo.update({ id: sessionId }, changes);
    const s = await this.findSessionOrFail(sessionId);
    if (input.title !== undefined) {
      // 单表 update，无事务边界；改名即读回已提交数据，可放心紧跟着通知。
      this.emitter.emit(SESSION_LIFECYCLE_EVENTS.renamed, {
        agentId: s.agentId,
        sessionId,
        title: s.title,
      } satisfies SessionRenamedEvent);
    }
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
    // 用户已手动改名（affected=0）时上面已提前 return，不会走到这里重复通知。
    this.emitter.emit(SESSION_LIFECYCLE_EVENTS.renamed, {
      agentId: s.agentId,
      sessionId,
      title: s.title,
    } satisfies SessionRenamedEvent);
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
    const agentId = await this.purgeSession(sessionId);
    // 删完才通知：先通知的话观察者可能在数据还在时就把行移除，然后被某个
    // 并发的列表刷新又加回来（闪回）。agentId 取自删除前查到的会话（删完
    // 这行数据已经没了，回查不到）。
    this.emitter.emit(SESSION_LIFECYCLE_EVENTS.deleted, {
      agentId,
      sessionId,
    } satisfies SessionDeletedEvent);
  }

  /**
   * 删除一个会话及其消息，**不发 `session.deleted`**——返回该会话的 agentId，
   * 由调用方在合适的时机自行通知。供 `AgentService.removeInDb`（删 Agent 时
   * 连同其全部会话一起清）调用。
   *
   * **为什么这条路径不能自己发事件**（review 抓出的架构缺口）：`removeInDb`
   * 本身挂着 `@Transactional()`，而本仓的事务装饰器是 REQUIRED 传播语义——
   * 嵌套调用只 join 外层事务、**不在本层提交**。所以从 `removeInDb` 内部调过来
   * 时，`purgeSession` 返回并不代表数据已落盘：真正的 commit 要等 `removeInDb`
   * 整个方法体（含循环之后的 `repo.delete({ id })`）跑完。此时若发通知，而外层
   * 事务随后回滚，就会出现「观察者已把这些会话移除，数据库里它们其实还在」
   * ——更糟的是 schedules / checkpointer 的删除是非事务性的，不会随回滚恢复，
   * 于是会话「复活」但定时任务和 checkpointer 已经没了。
   *
   * 与 `deleteSession` 共用 {@link purgeSession}，不另起一套级联删除实现。
   */
  removeWithMessages(sessionId: string): Promise<string> {
    return this.purgeSession(sessionId);
  }

  /** 级联删除的实际动作；返回被删会话的 agentId（供调用方组事件）。 */
  private async purgeSession(sessionId: string): Promise<string> {
    const session = await this.findSessionOrFail(sessionId);
    await this.deleteSessionInTx(sessionId);
    await this.schedules.deleteBySession(sessionId);
    await this.checkpointer.deleteThread(sessionId);
    return session.agentId;
  }

  @Transactional()
  private async deleteSessionInTx(sessionId: string): Promise<void> {
    await this.llmCalls.deleteBySession(sessionId);
    await this.sessionMessages.deleteBySession(sessionId);
    await this.pendingRepo.delete({ sessionId });
    await this.sessionRepo.delete({ id: sessionId });
  }

  /**
   * 范围内创建的会话数。since 为 null 表示全部。
   * 排除 kind=subagent（子 Agent 会话不是用户主动发起的会话，统计口径不计入；
   * quick 随手问会话仍计入，最小语义变化）。
   */
  async countCreatedSince(since: Date | null): Promise<number> {
    const qb = this.sessionRepo
      .scopedQueryBuilder("s")
      .andWhere("s.kind != 'subagent'");
    if (since) {
      qb.andWhere("datetime(s.created_at) >= datetime(:since)", {
        since: since.toISOString(),
      });
    }
    return qb.getCount();
  }

  /**
   * 系统级扫描：孤儿前台子会话——kind=subagent 且 background=0（前台）但仍
   * 残留活跃 pending（pending/processing）。
   *
   * 前台派发是父 run 同步 `kickAndWait` 等到子会话跑完才返回；若进程重启后
   * 这类子会话还有活跃 pending，说明父 run 随进程一起死了、不会再有人消费
   * 其结果（不同于 background=1 有 `settleBackground` 兜底续跑/补播报）。
   * background=0 的子会话绝大多数是正常跑完的（无活跃 pending），必须用
   * EXISTS 子查询只挑「仍有活跃 pending」的那部分，否则会把全部已完成的
   * 前台子会话误判为孤儿。
   *
   * 语义已拍板：只标记了结（markFailed + setStatus idle），不重跑——父上下文
   * 已死，重跑结果无人消费。仅供进程启动恢复用：boot 时无账号上下文，须
   * unscoped 反查后逐个建上下文处理。
   */
  listOrphanForegroundSubagentsUnscoped(): Promise<
    Array<{ id: string; cloudUserId: string }>
  > {
    // scope-check: allow-unscoped
    return this.sessionRepo
      .unscoped()
      .createQueryBuilder("s")
      .select("s.id", "id")
      .addSelect("s.cloudUserId", "cloudUserId")
      .where("s.kind = :kind", { kind: "subagent" })
      .andWhere("s.background = :bg", { bg: 0 })
      .andWhere(
        "EXISTS (SELECT 1 FROM pending_messages pm WHERE pm.session_id = s.id AND pm.status IN ('pending', 'processing'))",
      )
      .getRawMany();
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
    // 该消息若曾 run 失败（pending 行 status=failed），重生成即用户对这次失败
    // 的处置——置回 processed。否则重生成走 resume（batch=0）永远不清 failed，
    // 前端拉 pending 后消息恒标红、失败态无法退出。幂等：已 processed 不受影响。
    await this.markProcessed([messageId]);
  }
}
