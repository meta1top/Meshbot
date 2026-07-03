import { resolveContextWindow } from "@meshbot/types-agent";
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import type {
  CreateModelConfigDto,
  UpdateModelConfigDto,
} from "../dto/create-model-config.dto";
import { ModelConfig } from "../entities/model-config.entity";

/** ModelConfig 表的归属 Service —— 模型配置的数据层（按账号隔离）。 */
@Injectable()
export class ModelConfigService {
  /** ModelConfig 账号作用域仓库（自动按当前账号过滤/盖章）。 */
  private readonly repo: ScopedRepository<ModelConfig>;

  constructor(
    @InjectRepository(ModelConfig)
    rawRepo: Repository<ModelConfig>,
    scopedFactory: ScopedRepositoryFactory,
  ) {
    this.repo = scopedFactory.create(rawRepo);
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

  /** 创建并保存新 ModelConfig（自动盖上当前账号 cloudUserId）。 */
  async create(dto: CreateModelConfigDto): Promise<ModelConfig> {
    return this.repo.save({
      providerType: dto.providerType,
      name: dto.name,
      model: dto.model,
      apiKey: dto.apiKey,
      baseUrl: dto.baseUrl ?? "",
      enabled: true,
      contextWindow: resolveContextWindow(dto.model, dto.contextWindow),
    } as ModelConfig);
  }

  /**
   * 更新策略（contextWindow 解析）：
   * - dto.contextWindow 显式给值 → 直接覆盖
   * - 未给但 dto.model 变了 → 按新 model 重新解析（spec 自动跟进）
   * - 未给且 model 没变 → 保留原值（不动）
   */
  async update(id: string, dto: UpdateModelConfigDto): Promise<ModelConfig> {
    const entity = await this.findOneOrFail(id);
    const modelChanged = dto.model !== undefined && dto.model !== entity.model;
    Object.assign(entity, dto);
    if (dto.contextWindow !== undefined) {
      entity.contextWindow = dto.contextWindow;
    } else if (modelChanged) {
      entity.contextWindow = resolveContextWindow(entity.model);
    }
    return this.repo.save(entity);
  }

  /**
   * 删除指定 ModelConfig。
   * 先通过作用域 findOneOrFail 验证归属（不属于当前账号则抛 NOT_FOUND），
   * 再用作用域 delete 确保删除条件合并当前账号（防误删他账号行）。
   */
  async remove(id: string): Promise<void> {
    await this.findOneOrFail(id);
    await this.repo.delete({ id });
  }

  /** 判断当前账号是否有已启用的 ModelConfig。 */
  async hasEnabledModels(): Promise<boolean> {
    const count = await this.repo.count({ where: { enabled: true } });
    return count > 0;
  }

  /** 按 id 优先、name 次之查模型配置（dispatch model 覆盖用；含未启用）。查不到返回 null。 */
  async findByIdOrName(idOrName: string): Promise<ModelConfig | null> {
    const byId = await this.repo.findOneBy({ id: idOrName });
    if (byId) return byId;
    return this.repo.findOneBy({ name: idOrName });
  }
}
