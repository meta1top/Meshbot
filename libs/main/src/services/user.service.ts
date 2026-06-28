import { AppError } from "@meshbot/common";
import type { LoginInput, RegisterUserInput } from "@meshbot/types-main";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import * as bcrypt from "bcrypt";
import type { Repository } from "typeorm";

import { AppUser } from "../entities/app-user.entity";
import { MainErrorCode } from "../errors/main.error-codes";

const BCRYPT_COST = 12;

/**
 * 用户账户 Service —— AppUser 的唯一归属者。Phase 3 仅作为 server-main
 * 框架基线（TypeORM + 迁移 + DTO + i18n + JWT 链路）的最小示范，
 * 真实业务等 meshbot 自行落地后再叠加。
 */
@Injectable()
export class UserService {
  constructor(
    @InjectRepository(AppUser)
    private readonly userRepo: Repository<AppUser>,
  ) {}

  async registerUser(input: RegisterUserInput): Promise<AppUser> {
    const existing = await this.userRepo.findOne({
      where: { email: input.email },
    });
    if (existing) throw new AppError(MainErrorCode.AUTH_EMAIL_EXISTS);

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);
    const user = this.userRepo.create({
      email: input.email,
      passwordHash,
      displayName: input.displayName,
    });
    return this.userRepo.save(user);
  }

  async loginUser(input: LoginInput): Promise<AppUser> {
    const user = await this.userRepo.findOne({
      where: { email: input.email },
    });
    if (!user) throw new AppError(MainErrorCode.AUTH_INVALID_CREDENTIALS);
    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) throw new AppError(MainErrorCode.AUTH_INVALID_CREDENTIALS);
    return user;
  }

  async findById(id: string): Promise<AppUser | null> {
    return this.userRepo.findOne({ where: { id } });
  }

  /** 设置用户当前活跃组织（单表 update app_user.active_org_id）。调用方负责先校验成员资格。 */
  async setActiveOrg(userId: string, orgId: string): Promise<void> {
    await this.userRepo.update({ id: userId }, { activeOrgId: orgId });
  }
}
