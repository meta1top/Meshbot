import { Transactional } from "@meshbot/common";
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { ModelConfig } from "../entities/model-config.entity";
import { CloudModelConfigProxyService } from "./cloud-model-config-proxy.service";

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
    private readonly proxy: CloudModelConfigProxyService,
  ) {
    this.repo = scopedFactory.create(rawRepo);
    this.txAnchorRepo = rawRepo;
  }

  /** 列出当前账号所有 ModelConfig（本地 local 行 + 云端代理行，按 id 去重、本地优先）。 */
  async findAll(): Promise<ModelConfig[]> {
    const local = await this.repo.find({ where: { source: "local" } });
    const cloud = await this.proxy.getCloudConfigs();
    return this.mergeById(local, cloud);
  }

  /** 列出当前账号所有已启用的 ModelConfig（合并后按 enabled 过滤）。 */
  async findAllEnabled(): Promise<ModelConfig[]> {
    const all = await this.findAll();
    return all.filter((c) => c.enabled);
  }

  /** 取第一条已启用的 ModelConfig；无则返 null。供 ContextCompactor 使用。 */
  async findEnabled(): Promise<ModelConfig | null> {
    const rows = await this.findAllEnabled();
    return rows[0] ?? null;
  }

  /**
   * 按 id 查单条：本地 local 行优先，未命中查云端代理；都无则抛 NotFoundException。
   * 云端不可达时代理返回空列表 → 相当于云端未命中。
   */
  async findOneOrFail(id: string): Promise<ModelConfig> {
    const local = await this.repo.findOneBy({ id, source: "local" });
    if (local) return local;
    const cloud = await this.proxy.getCloudConfigs();
    const found = cloud.find((c) => c.id === id);
    if (!found) throw new NotFoundException(`ModelConfig ${id} not found`);
    return found;
  }

  /** 判断当前账号是否有已启用的 ModelConfig（本地或云端任一有 enabled）。 */
  async hasEnabledModels(): Promise<boolean> {
    return (await this.findAllEnabled()).length > 0;
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

  /**
   * 按 id 优先、name 次之查模型配置（dispatch model 覆盖 / runner 解析用；含未启用）。
   * 本地 local 行优先（id→name），未命中查云端代理（id→name）；都无返回 null。
   */
  async findByIdOrName(idOrName: string): Promise<ModelConfig | null> {
    const localById = await this.repo.findOneBy({
      id: idOrName,
      source: "local",
    });
    if (localById) return localById;
    const localByName = await this.repo.findOneBy({
      name: idOrName,
      source: "local",
    });
    if (localByName) return localByName;
    const cloud = await this.proxy.getCloudConfigs();
    return cloud.find((c) => c.id === idOrName || c.name === idOrName) ?? null;
  }

  /** 按 id 去重合并两组配置，本地行覆盖同 id 云端行（本地优先）。 */
  private mergeById(local: ModelConfig[], cloud: ModelConfig[]): ModelConfig[] {
    const seen = new Set(local.map((c) => c.id));
    return [...local, ...cloud.filter((c) => !seen.has(c.id))];
  }
}
