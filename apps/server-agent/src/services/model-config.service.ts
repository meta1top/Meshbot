import { Transactional } from "@meshbot/common";
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { ModelConfig } from "../entities/model-config.entity";

/** ModelConfig.contextWindow 的兜底值（entity 列默认值），行映射未给出时使用。 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * 云端网关坐标行——「云端模型网关」下发的 `AgentModelConfig`（仅 id/name/
 * contextWindow/enabled，不含厂商敏感字段）已由 ModelConfigSyncService 映射
 * 为该形状：`providerType` 固定 `openai-compatible`、`baseUrl` 指向本地网关
 * 代理端点、`model` 用云端配置 id 做调用引用、`apiKey` 是占位符（真实厂商
 * key 只在云端持有，网关请求时按 device token 换发，见 Task 8）。
 */
export interface CloudModelConfigRow {
  /**
   * 本地行主键，直接采用云端 OrgModelConfig 的 id（雪花，显式赋值时
   * SnowflakeBaseEntity 的 @BeforeInsert 不覆盖）。跨同步稳定——同步是
   * 先删后插的全量替换，若让 hook 每轮生成新雪花，sessions.model_config_id
   * 的会话级模型引用会在下一轮同步后全部变成死 id（run 时报「模型配置不存在」）。
   */
  id: string;
  providerType: string;
  name: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  enabled: boolean;
  contextWindow: number | null;
}

/** ModelConfig 表的归属 Service —— 模型配置的数据层（按账号隔离）。 */
@Injectable()
export class ModelConfigService {
  /** ModelConfig 账号作用域仓库（自动按当前账号过滤/盖章）。 */
  private readonly repo: ScopedRepository<ModelConfig>;

  /**
   * 裸 ModelConfig 仓库：仅供 @Transactional() 的 findDataSource 反射遍历 service
   * 字段定位 DataSource（作用域仓库不是 Repository 实例，取不到 DataSource），
   * 业务读写一律走 repo 作用域仓库。
   */
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: findDataSource 反射读取
  private readonly txAnchorRepo: Repository<ModelConfig>;

  constructor(
    @InjectRepository(ModelConfig)
    rawRepo: Repository<ModelConfig>,
    scopedFactory: ScopedRepositoryFactory,
  ) {
    this.repo = scopedFactory.create(rawRepo);
    this.txAnchorRepo = rawRepo;
  }

  /** 列出当前账号所有已启用的 ModelConfig。 */
  findAllEnabled(): Promise<ModelConfig[]> {
    return this.repo.find({ where: { enabled: true } });
  }

  /** 取第一条已启用的 ModelConfig；无则返 null。供 ContextCompactor 使用。 */
  async findEnabled(): Promise<ModelConfig | null> {
    const rows = await this.findAllEnabled();
    return rows[0] ?? null;
  }

  /** 列出当前账号所有 ModelConfig。 */
  findAll(): Promise<ModelConfig[]> {
    return this.repo.find();
  }

  /**
   * 按 id 查单条；不存在或不属于当前账号则抛 NotFoundException。
   * 作用域查询保证他账号的 id 对当前账号不可见。
   */
  async findOneOrFail(id: string): Promise<ModelConfig> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`ModelConfig ${id} not found`);
    return entity;
  }

  /** 判断当前账号是否有已启用的 ModelConfig。 */
  async hasEnabledModels(): Promise<boolean> {
    const count = await this.repo.count({ where: { enabled: true } });
    return count > 0;
  }

  /**
   * 整体替换当前账号的云端来源（source='cloud'）模型配置缓存行。
   * 本地手工维护的 source='local' 行不受影响——本地模型配置写 REST 已下线，
   * 云端组织模型配置是唯一的写入来源，登录/启动/定时同步调用本方法。
   */
  async replaceCloudConfigs(rows: CloudModelConfigRow[]): Promise<void> {
    return this.persistCloudConfigs(rows);
  }

  /**
   * 同表先删后插的跨行原子操作，挂 @Transactional 防同步中途崩溃留半态
   * （删完旧 cloud 行、插新行插到一半失败，会导致该账号模型配置整体丢失）。
   */
  @Transactional()
  private async persistCloudConfigs(
    rows: CloudModelConfigRow[],
  ): Promise<void> {
    await this.repo.delete({ source: "cloud" });
    for (const r of rows) {
      await this.repo.save({
        id: r.id,
        providerType: r.providerType,
        name: r.name,
        model: r.model,
        apiKey: r.apiKey,
        baseUrl: r.baseUrl,
        enabled: r.enabled,
        contextWindow: r.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        source: "cloud",
      } as ModelConfig);
    }
  }

  /** 按 id 优先、name 次之查模型配置（dispatch model 覆盖用；含未启用）。查不到返回 null。 */
  async findByIdOrName(idOrName: string): Promise<ModelConfig | null> {
    const byId = await this.repo.findOneBy({ id: idOrName });
    if (byId) return byId;
    return this.repo.findOneBy({ name: idOrName });
  }
}
