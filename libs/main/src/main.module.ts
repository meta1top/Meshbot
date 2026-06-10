import { TxTypeOrmModule } from "@meshbot/common";
import { type DynamicModule, Module } from "@nestjs/common";

import { AppUser } from "./entities/app-user.entity";
import { Invitation } from "./entities/invitation.entity";
import { Membership } from "./entities/membership.entity";
import { Organization } from "./entities/organization.entity";
import {
  type AppConfigInvitation,
  INVITATION_CONFIG,
} from "./services/invitation.config";
import { InvitationService } from "./services/invitation.service";
import { MembershipService } from "./services/membership.service";
import { OrgService } from "./services/org.service";
import { UserService } from "./services/user.service";

/**
 * server-main 业务模块。Entity → Service 一对一归属（check:repo）：
 * AppUser→UserService / Organization→OrgService /
 * Membership→MembershipService / Invitation→InvitationService。
 *
 * `forRoot(invitation)` 注入邀请配置切片（过期天数），由 server-main 的
 * AppConfig.invitation 提供。
 *
 * 约定（静态围栏强制）：
 * - 跨表写动作走 `@Transactional()`，跨 Service 写动作通过被调 Service 的方法（不注 Repository）
 * - `@WithLock` 包 `@Transactional`（`check:lock-tx` 围栏）
 * - 私有事务方法命名 `*InTx` / `*InDb` / `*InTransaction` / `persist*`（`check:naming` 围栏）
 *
 * `TxTypeOrmModule.forFeature` 替代原生 `TypeOrmModule.forFeature`，
 * Repository 会自动感知 `@Transactional()` 上下文。
 *
 * **不在此处 `import CommonModule.forRoot()`**：CommonModule 必须由根 AppModule
 * 唯一注册（`global: true`），否则 `@WithLock` 装饰器可能拿到不同的 LockProvider
 * 实例。本地 Memory 模式与云端 Redis 模式都由 AppModule 决定。
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: NestJS DynamicModule 模式要求 class + 静态 forRoot
export class MainModule {
  static forRoot(invitation: AppConfigInvitation): DynamicModule {
    return {
      module: MainModule,
      imports: [
        TxTypeOrmModule.forFeature([
          AppUser,
          Organization,
          Membership,
          Invitation,
        ]),
      ],
      providers: [
        UserService,
        OrgService,
        MembershipService,
        InvitationService,
        { provide: INVITATION_CONFIG, useValue: invitation },
      ],
      exports: [UserService, OrgService, MembershipService, InvitationService],
    };
  }
}
