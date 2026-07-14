import { AccountContextService } from "@meshbot/lib-agent";
import {
  DEFAULT_AGENT_AVATAR,
  DEFAULT_AGENT_NAME,
  type AgentCreateInput,
  type AgentUpdateInput,
} from "@meshbot/types-agent";
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { Agent } from "../entities/agent.entity";

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

  /** 删除 Agent。注意：磁盘目录由调用方（Controller）负责清理。 */
  async remove(id: string): Promise<void> {
    await this.findOrThrow(id);
    await this.repo.delete({ id });
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
