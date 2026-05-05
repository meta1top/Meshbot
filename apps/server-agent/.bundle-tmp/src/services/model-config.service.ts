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
    });
    return this.repo.save(entity);
  }

  async update(id: string, dto: UpdateModelConfigDto): Promise<ModelConfig> {
    const entity = await this.findOneOrFail(id);
    Object.assign(entity, dto);
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
