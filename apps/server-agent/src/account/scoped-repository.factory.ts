import { AccountContextService } from "@meshbot/agent";
import { Injectable } from "@nestjs/common";
import type { ObjectLiteral, Repository } from "typeorm";
import { ScopedRepository } from "./scoped-repository";

/** 把裸 Repository 包成 ScopedRepository。归属 Service 在构造里调用。 */
@Injectable()
export class ScopedRepositoryFactory {
  constructor(private readonly ctx: AccountContextService) {}

  /** 包裹一个裸 Repository，返回账号作用域仓库。 */
  create<T extends ObjectLiteral>(repo: Repository<T>): ScopedRepository<T> {
    return new ScopedRepository<T>(repo, this.ctx);
  }
}
