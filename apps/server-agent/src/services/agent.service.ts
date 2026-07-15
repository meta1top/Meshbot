import { rmSync } from "node:fs";
import { Transactional } from "@meshbot/common";
import {
  AccountContextService,
  MeshbotConfigService,
} from "@meshbot/lib-agent";
import {
  DEFAULT_AGENT_AVATAR,
  DEFAULT_AGENT_NAME,
  type AgentCreateInput,
  type AgentUpdateInput,
} from "@meshbot/types-agent";
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
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
  ) {
    this.repo = scopedFactory.create(rawRepo);
    this.txAnchorRepo = rawRepo;
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
    return this.repo.save({
      name: input.name,
      avatar: input.avatar,
      description: input.description,
      systemPrompt: input.systemPrompt,
      defaultModelConfigId: input.defaultModelConfigId,
    } as Agent);
  }

  /** 更新 Agent（只覆盖传入字段）。 */
  async update(id: string, input: AgentUpdateInput): Promise<Agent> {
    const agent = await this.findOrThrow(id);
    Object.assign(agent, input);
    return this.repo.save(agent);
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
   * 跨表写入（agents + sessions + session_messages 等），故内部挂
   * `@Transactional()`；磁盘删除放在事务**之后**（文件系统不参与事务，先删
   * 文件后回滚会丢数据，只能在 DB 事务确认提交后再删盘）。
   *
   * 不允许删到零 Agent：`sessions.agent_id` 是 NOT NULL，零 Agent 会让建
   * 会话直接失败，故至少保留一个。
   */
  async removeWithData(id: string): Promise<void> {
    const all = await this.list();
    if (all.length <= 1) {
      throw new BadRequestException("至少保留一个 Agent");
    }
    await this.removeInDb(id);
    rmSync(this.config.agentDirOf(id), { recursive: true, force: true });
  }

  /**
   * 删 Agent 及其会话（含消息）。磁盘目录由调用方（`removeWithData`）在事务外清理。
   *
   * tx-check: ignore (check:tx 的跨 service 写识别只认字段名以 `Service` 结尾；
   * 本类把 `SessionService` 注入成 `private readonly sessions`，脚本看不到
   * `this.sessions.removeWithMessages(...)` 这处写，只数到 `this.repo.delete(...)`
   * 1 处、误判 REDUNDANT。实际跨 agents / sessions / session_messages /
   * pending_messages / llm_calls 多表写入，`@Transactional()` 必须保留。)
   */
  @Transactional()
  private async removeInDb(id: string): Promise<void> {
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
