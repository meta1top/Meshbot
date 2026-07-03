import { Transactional } from "@meshbot/common";
import type { AgentModelConfig } from "@meshbot/types";
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { ModelConfig } from "../entities/model-config.entity";

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
  async replaceCloudConfigs(configs: AgentModelConfig[]): Promise<void> {
    return this.persistCloudConfigs(configs);
  }

  /**
   * 同表先删后插的跨行原子操作，挂 @Transactional 防同步中途崩溃留半态
   * （删完旧 cloud 行、插新行插到一半失败，会导致该账号模型配置整体丢失）。
   */
  @Transactional()
  private async persistCloudConfigs(
    configs: AgentModelConfig[],
  ): Promise<void> {
    await this.repo.delete({ source: "cloud" });
    for (const c of configs) {
      await this.repo.save({
        providerType: c.providerType,
        name: c.name,
        model: c.model,
        apiKey: c.apiKey,
        baseUrl: c.baseUrl,
        enabled: c.enabled,
        contextWindow: c.contextWindow,
        source: "cloud",
      } as ModelConfig);
    }
  }
}
