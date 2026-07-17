import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { ModelConfig } from "../entities/model-config.entity";
import { CloudModelConfigProxyService } from "./cloud-model-config-proxy.service";

/** ModelConfig 表的归属 Service —— 模型配置的数据层（按账号隔离）。 */
@Injectable()
export class ModelConfigService {
  /** ModelConfig 账号作用域仓库（自动按当前账号过滤/盖章）。 */
  private readonly repo: ScopedRepository<ModelConfig>;

  constructor(
    @InjectRepository(ModelConfig)
    rawRepo: Repository<ModelConfig>,
    scopedFactory: ScopedRepositoryFactory,
    private readonly proxy: CloudModelConfigProxyService,
  ) {
    this.repo = scopedFactory.create(rawRepo);
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
