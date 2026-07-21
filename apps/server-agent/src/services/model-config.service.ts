import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { AppError } from "@meshbot/common";
import { resolveContextWindow } from "@meshbot/types-agent";
import { Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import type {
  CreateModelConfigDto,
  UpdateModelConfigDto,
} from "../dto/model-config.dto";
import { ModelConfig } from "../entities/model-config.entity";
import { AgentErrorCode } from "../errors/agent.error-codes";
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

  /** 新建本地模型配置（source='local'，enabled 默认 true）。单表写，无需 @Transactional。 */
  async create(dto: CreateModelConfigDto): Promise<ModelConfig> {
    return this.repo.save({
      providerType: dto.providerType,
      name: dto.name,
      model: dto.model,
      apiKey: dto.apiKey,
      baseUrl: dto.baseUrl ?? "",
      enabled: true,
      contextWindow: resolveContextWindow(dto.model, dto.contextWindow),
      source: "local",
    } as ModelConfig);
  }

  /**
   * 更新本地模型配置（只碰 source='local'）。contextWindow 策略：
   * 显式给值 → 覆盖；未给但 model 变了 → 按新 model 重解析；否则保留原值。
   * 目标是云端条目 → MODEL_CONFIG_READONLY；不存在 → NotFound。
   */
  async update(id: string, dto: UpdateModelConfigDto): Promise<ModelConfig> {
    const entity = await this.findLocalOrReject(id);
    const modelChanged = dto.model !== undefined && dto.model !== entity.model;
    Object.assign(entity, dto);
    if (dto.contextWindow !== undefined) {
      entity.contextWindow = dto.contextWindow;
    } else if (modelChanged) {
      entity.contextWindow = resolveContextWindow(entity.model);
    }
    return this.repo.save(entity);
  }

  /** 切换本地模型配置启用态（只碰 source='local'）。 */
  async setEnabled(id: string, enabled: boolean): Promise<ModelConfig> {
    const entity = await this.findLocalOrReject(id);
    entity.enabled = enabled;
    return this.repo.save(entity);
  }

  /** 删除本地模型配置（只碰 source='local'）。 */
  async delete(id: string): Promise<void> {
    await this.findLocalOrReject(id);
    await this.repo.delete({ id, source: "local" });
  }

  /**
   * 定位可写的本地行：命中 source='local' 返回；否则查云端代理——
   * 命中云端 → MODEL_CONFIG_READONLY（编辑去云端 org），都无 → NotFound。
   */
  private async findLocalOrReject(id: string): Promise<ModelConfig> {
    const local = await this.repo.findOneBy({ id, source: "local" });
    if (local) return local;
    const cloud = await this.proxy.getCloudConfigs();
    if (cloud.some((c) => c.id === id)) {
      throw new AppError(AgentErrorCode.MODEL_CONFIG_READONLY);
    }
    throw new NotFoundException(`ModelConfig ${id} not found`);
  }
}
