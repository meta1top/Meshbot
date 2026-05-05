import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Setting } from "../entities/setting.entity";

@Injectable()
export class SettingService {
  constructor(
    @InjectRepository(Setting)
    private readonly repo: Repository<Setting>,
  ) {}

  findAll(): Promise<Setting[]> {
    return this.repo.find();
  }

  async get(key: string): Promise<string | null> {
    const entity = await this.repo.findOneBy({ key });
    return entity?.value ?? null;
  }

  async set(key: string, value: string): Promise<Setting> {
    let entity = await this.repo.findOneBy({ key });
    if (entity) {
      entity.value = value;
    } else {
      entity = this.repo.create({ key, value });
    }
    return this.repo.save(entity);
  }

  async remove(key: string): Promise<void> {
    await this.repo.delete({ key });
  }
}
