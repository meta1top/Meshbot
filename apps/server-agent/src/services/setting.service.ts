import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { Setting } from "../entities/setting.entity";

/** Setting 表的归属 Service —— 键值设置的数据层（按账号隔离，复合主键 cloudUserId+key）。 */
@Injectable()
export class SettingService {
  /** Setting 账号作用域仓库（自动按当前账号过滤/盖章）。 */
  private readonly repo: ScopedRepository<Setting>;

  constructor(
    @InjectRepository(Setting)
    rawRepo: Repository<Setting>,
    scopedFactory: ScopedRepositoryFactory,
  ) {
    this.repo = scopedFactory.create(rawRepo);
  }

  /** 列出当前账号所有设置项。 */
  findAll(): Promise<Setting[]> {
    return this.repo.find();
  }

  /** 取指定 key 的值；不存在则返回 null。 */
  async get(key: string): Promise<string | null> {
    const entity = await this.repo.findOneBy({ key });
    return entity?.value ?? null;
  }

  /**
   * 设置指定 key 的值（upsert）。
   * 复合主键 (cloudUserId, key)：save 自动盖上当前账号，TypeORM 对已存在行做更新。
   */
  async set(key: string, value: string): Promise<Setting> {
    return this.repo.save({ key, value } as Setting);
  }

  /** 删除指定 key 的设置项（仅影响当前账号的行）。 */
  async remove(key: string): Promise<void> {
    await this.repo.delete({ key });
  }
}
