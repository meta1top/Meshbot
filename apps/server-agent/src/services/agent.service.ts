import { rmSync } from "node:fs";
import { Transactional } from "@meshbot/common";
import {
  AccountContextService,
  MeshbotConfigService,
} from "@meshbot/lib-agent";
import {
  AGENT_EVENTS,
  DEFAULT_AGENT_AVATAR,
  DEFAULT_AGENT_NAME,
  type AgentChangedEvent,
  type AgentCreateInput,
  type AgentUpdateInput,
} from "@meshbot/types-agent";
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { Agent } from "../entities/agent.entity";
import { SessionService } from "./session.service";

/** Agent 表的归属 Service —— 一个设备下多个 Agent 的数据层（按账号隔离）。 */
@Injectable()
export class AgentService {
  /** Agent 账号作用域仓库（自动按当前账号过滤/盖章）。 */
  private readonly repo: ScopedRepository<Agent>;

  /** 裸仓库：仅供 @Transactional 的 findDataSource 反射定位 DataSource，业务读写一律走 repo。 */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: findDataSource 反射读取
  private readonly txAnchorRepo: Repository<Agent>;

  /**
   * `ensureDefault()` 按账号 key 缓存进行中的 promise（进程内 in-flight 去重）。
   * check-then-act（list 读 → create 写）之间有 await 边界，同账号并发调用会各自
   * 读到零 agent 并各建一个，需要复用同一个 in-flight promise 避免建出重复默认 Agent；
   * 本地轨单进程 + SQLite、无 Redis，这个量级足够，不需要 @WithLock。
   */
  private readonly ensureDefaultInFlight = new Map<string, Promise<Agent>>();

  constructor(
    @InjectRepository(Agent)
    rawRepo: Repository<Agent>,
    scopedFactory: ScopedRepositoryFactory,
    private readonly accountContext: AccountContextService,
    private readonly config: MeshbotConfigService,
    // AgentsModule ↔ SessionModule 互相 import（AgentService 需要 SessionService
    // 删会话，SessionModule 的 Controller/RunnerService 需要 AgentService 兜底取
    // 默认 Agent），模块级形成环，用 forwardRef 打开；Service 层本身单向
    // （SessionService 不反向依赖 AgentService），无需在此处也包 forwardRef。
    private readonly sessions: SessionService,
    private readonly emitter: EventEmitter2,
  ) {
    this.repo = scopedFactory.create(rawRepo);
    this.txAnchorRepo = rawRepo;
  }

  /**
   * Agent 增删改成功后发 `AGENT_EVENTS.changed`。
   *
   * 放在 Service 层而非 Controller：`rename_agent` 工具走 `AGENT_RENAME_PORT`
   * → `update()`，不经过 Controller；发射点下沉后两条路径（REST 表单 / Agent
   * 工具）都能同时驱动云端对账推送与浏览器侧栏刷新。
   */
  private emitChanged(agentId: string): void {
    this.emitter.emit(AGENT_EVENTS.changed, {
      cloudUserId: this.accountContext.getOrThrow(),
      agentId,
    } satisfies AgentChangedEvent);
  }

  /** 列出当前账号的全部 Agent，按 sortOrder、创建时间升序。 */
  list(): Promise<Agent[]> {
    return this.repo.find({
      order: { sortOrder: "ASC", createdAt: "ASC" },
    });
  }

  /** 按 id 取 Agent；不存在或不属于当前账号返回 null。 */
  findOrNull(id: string): Promise<Agent | null> {
    return this.repo.findOne({ where: { id } });
  }

  /** 按 id 取 Agent；不存在抛 404。 */
  async findOrThrow(id: string): Promise<Agent> {
    const agent = await this.findOrNull(id);
    if (!agent) {
      throw new NotFoundException(`Agent 不存在：${id}`);
    }
    return agent;
  }

  /**
   * 创建一个 Agent。
   * 直接把 plain object（转 Agent 类型）交给 `repo.save`——`ScopedRepository.save`
   * 内部会先 `create()` 成真实体实例再落库，`SnowflakeBaseEntity` 的 `@BeforeInsert`
   * 才会触发生成雪花 id；`ScopedRepository` 本身不暴露 `create()` 方法。
   */
  async create(input: AgentCreateInput): Promise<Agent> {
    const created = await this.repo.save({
      name: input.name,
      avatar: input.avatar,
      description: input.description,
      systemPrompt: input.systemPrompt,
      defaultModelConfigId: input.defaultModelConfigId,
    } as Agent);
    this.emitChanged(created.id);
    return created;
  }

  /** 更新 Agent（只覆盖传入字段）。 */
  async update(id: string, input: AgentUpdateInput): Promise<Agent> {
    const agent = await this.findOrThrow(id);
    Object.assign(agent, input);
    const saved = await this.repo.save(agent);
    this.emitChanged(saved.id);
    return saved;
  }

  /**
   * 解析 agentId：未传 / 空字符串兜底取当前账号默认 Agent（`ensureDefault`）；
   * 显式传入非空 agentId 必须校验存在且归属当前账号（`findOrThrow` 经
   * `ScopedRepository` 自动按账号过滤，越权 id 天然 404）。
   *
   * 收口 `SessionController.create()` / `SkillController`/`ArtifactController`
   * 的 `resolveAgentId()` 私有重复实现——四处语义完全一致，改为单点维护。
   * 注意不能用 `??`：空字符串不是 `null`/`undefined`，`??` 只会原样把空串当
   * 「已指定」传给 `findOrThrow`，必须用真值判断把空串也归入「未指定」分支。
   */
  async resolveOrDefault(agentId?: string | null): Promise<Agent> {
    if (agentId) {
      return this.findOrThrow(agentId);
    }
    return this.ensureDefault();
  }

  /**
   * 删除 Agent —— 连同它的全部会话与磁盘目录一起清掉。
   *
   * 「至少保留一个」的检查在 `removeInDb` 的事务内部完成（见其注释）——
   * 磁盘删除放在事务**之后**（文件系统不参与事务，先删文件后回滚会丢数据，
   * 只能在 DB 事务确认提交后再删盘）。
   */
  async removeWithData(id: string): Promise<void> {
    await this.removeInDb(id);
    rmSync(this.config.agentDirOf(id), { recursive: true, force: true });
    this.emitChanged(id);
  }

  /**
   * 删 Agent 及其会话（含消息）。磁盘目录由调用方（`removeWithData`）在事务外清理。
   *
   * 「至少保留一个 Agent」的 check-then-act 竞态修复：原先这个检查在
   * `removeWithData` 里、`@Transactional()` 事务**外面**——两个并发删不同
   * Agent 的请求都能在事务外读到 `length=2`、都通过检查，各自事务再各删各的，
   * 最终把账号删到 0 个 Agent（`sessions.agent_id` NOT NULL，零 Agent 会让
   * 建会话直接失败）。
   *
   * 修法：把检查挪到这个方法最开头、`@Transactional()` 事务内部、删除动作
   * 之前。本仓库 sqlite 系驱动的 root 事务由 `Transactional()` 装饰器按
   * DataSource 通过 `runExclusive`（FIFO promise 链）强制串行——同一 DataSource
   * 上任意时刻至多一个 root 事务在跑，第二个事务只会在第一个事务
   * commit/rollback 之后才真正开始执行方法体。于是两个并发
   * `removeInDb` 调用：先拿到执行权的那个读到 `length=2`、通过检查、
   * 删除并提交；后拿到执行权的那个此时已经能读到提交后的最新状态
   * （`length=1`），检查失败并抛错回滚。这个串行化由 `runExclusive` 在
   * 应用层（JS Promise 链）保证，不依赖 SQLite 引擎本身的锁行为，
   * `:memory:` 与文件库下都成立。
   *
   * tx-check: ignore (check:tx 的跨 service 写识别只认字段名以 `Service` 结尾；
   * 本类把 `SessionService` 注入成 `private readonly sessions`，脚本看不到
   * `this.sessions.removeWithMessages(...)` 这处写，只数到 `this.repo.delete(...)`
   * 1 处、误判 REDUNDANT。实际跨 agents / sessions / session_messages /
   * pending_messages / llm_calls 多表写入，`@Transactional()` 必须保留。)
   */
  @Transactional()
  private async removeInDb(id: string): Promise<void> {
    const all = await this.list();
    if (all.length <= 1) {
      throw new BadRequestException("至少保留一个 Agent");
    }
    await this.findOrThrow(id);
    const sessions = await this.sessions.findByAgentId(id);
    for (const s of sessions) {
      await this.sessions.removeWithMessages(s.id);
    }
    await this.repo.delete({ id });
  }

  /**
   * 复制一个 Agent 的配置（名字加「(副本)」后缀）。
   * 只复制元数据——记忆 / 工作区 / 已装技能 / MCP 配置**不复制**，副本从零开始
   * （磁盘目录按新 id 首次访问时才 mkdir，不预先创建）。
   */
  async duplicate(id: string): Promise<Agent> {
    const src = await this.findOrThrow(id);
    return this.create({
      name: `${src.name} (副本)`,
      avatar: src.avatar,
      description: src.description,
      systemPrompt: src.systemPrompt,
      defaultModelConfigId: src.defaultModelConfigId,
    });
  }

  /**
   * 保证当前账号至少有一个 Agent：零 agent 时建默认 Agent，否则返回第一个。
   * 启动引导与登录后都会调；幂等——按账号 key 做 in-flight 去重，同账号并发调用
   * 复用同一个进行中的 promise，避免 list→create 之间的 await 边界导致重复建 Agent。
   */
  async ensureDefault(): Promise<Agent> {
    const cloudUserId = this.accountContext.getOrThrow();
    const existing = this.ensureDefaultInFlight.get(cloudUserId);
    if (existing) {
      return existing;
    }
    const inFlight = this.doEnsureDefault().finally(() => {
      this.ensureDefaultInFlight.delete(cloudUserId);
    });
    this.ensureDefaultInFlight.set(cloudUserId, inFlight);
    return inFlight;
  }

  /** ensureDefault 实际读写逻辑：零 agent 时建默认 Agent，否则返回第一个。 */
  private async doEnsureDefault(): Promise<Agent> {
    const existing = await this.list();
    if (existing.length > 0) {
      return existing[0];
    }
    return this.create({
      name: DEFAULT_AGENT_NAME,
      avatar: DEFAULT_AGENT_AVATAR,
      description: "",
      systemPrompt: "",
      defaultModelConfigId: null,
    });
  }
}
