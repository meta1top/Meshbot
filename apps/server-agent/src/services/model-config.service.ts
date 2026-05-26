import { resolveContextWindow } from "@meshbot/types-agent";
import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import type {
  CreateModelConfigDto,
  UpdateModelConfigDto,
} from "../dto/create-model-config.dto";
import { ModelConfig } from "../entities/model-config.entity";

@Injectable()
export class ModelConfigService {
  constructor(
    @InjectRepository(ModelConfig)
    private readonly repo: Repository<ModelConfig>,
  ) {}

  findAllEnabled(): Promise<ModelConfig[]> {
    return this.repo.find({ where: { enabled: true } });
  }

  /** 取第一条已启用的 ModelConfig；无则返 null。供 ContextCompactor 使用。 */
  async findEnabled(): Promise<ModelConfig | null> {
    const rows = await this.findAllEnabled();
    return rows[0] ?? null;
  }

  findAll(): Promise<ModelConfig[]> {
    return this.repo.find();
  }

  async findOneOrFail(id: string): Promise<ModelConfig> {
    const entity = await this.repo.findOneBy({ id });
    if (!entity) throw new NotFoundException(`ModelConfig ${id} not found`);
    return entity;
  }

  async create(dto: CreateModelConfigDto): Promise<ModelConfig> {
    const entity = this.repo.create({
      providerType: dto.providerType,
      name: dto.name,
      model: dto.model,
      apiKey: dto.apiKey,
      baseUrl: dto.baseUrl ?? "",
      enabled: true,
      contextWindow: resolveContextWindow(dto.model, dto.contextWindow),
    });
    return this.repo.save(entity);
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

  async remove(id: string): Promise<void> {
    const entity = await this.findOneOrFail(id);
    await this.repo.remove(entity);
  }

  async hasEnabledModels(): Promise<boolean> {
    const count = await this.repo.countBy({ enabled: true });
    return count > 0;
  }
}
