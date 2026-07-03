import { TxTypeOrmModule } from "@meshbot/common";
import { type DynamicModule, Module } from "@nestjs/common";

import { AppUser } from "./entities/app-user.entity";
import { Conversation } from "./entities/conversation.entity";
import { ConversationMember } from "./entities/conversation-member.entity";
import { Device } from "./entities/device.entity";
import { DeviceAuthRequest } from "./entities/device-auth-request.entity";
import { EmailVerification } from "./entities/email-verification.entity";
import { Invitation } from "./entities/invitation.entity";
import { Membership } from "./entities/membership.entity";
import { Message } from "./entities/message.entity";
import { Organization } from "./entities/organization.entity";
import { OrgModelConfig } from "./entities/org-model-config.entity";
import { CloudNode } from "./entities/cloud-node.entity";
import { CloudNodeGrant } from "./entities/cloud-node-grant.entity";
import { CloudShareLink } from "./entities/cloud-share-link.entity";
import { SkillPackage } from "./entities/skill-package.entity";
import { SkillVersion } from "./entities/skill-version.entity";
import {
  type AppConfigInvitation,
  INVITATION_CONFIG,
} from "./services/invitation.config";
import { ConversationService } from "./services/conversation.service";
import { DeviceAuthService } from "./services/device-auth.service";
import { DeviceService } from "./services/device.service";
import { EmailVerificationService } from "./services/email-verification.service";
import { InvitationService } from "./services/invitation.service";
import { MembershipService } from "./services/membership.service";
import { MessageService } from "./services/message.service";
import { OrgService } from "./services/org.service";
import { OrgModelConfigService } from "./services/org-model-config.service";
import { CloudNodeService } from "./services/cloud-node.service";
import { CloudNodeGrantService } from "./services/cloud-node-grant.service";
import { CloudDriveService } from "./services/cloud-drive.service";
import { CloudShareLinkService } from "./services/cloud-share-link.service";
import { PresenceService } from "./services/presence.service";
import { DevicePresenceService } from "./services/device-presence.service";
import {
  type SecurityConfig,
  SecretCryptoService,
} from "./services/secret-crypto.service";
import { SkillMarketService } from "./services/skill-market.service";
import { SkillPackageService } from "./services/skill-package.service";
import { UserService } from "./services/user.service";
import { SECURITY_CONFIG } from "./tokens";

/**
 * server-main 业务模块。Entity → Service 一对一归属（check:repo）：
 * AppUser→UserService / Organization→OrgService /
 * Membership→MembershipService / Invitation→InvitationService /
 * Conversation+ConversationMember→ConversationService / Message→MessageService /
 * SkillPackage+SkillVersion→SkillPackageService（SkillMarketService 编排）/
 * CloudNode→CloudNodeService / CloudNodeGrant→CloudNodeGrantService /
 * CloudShareLink→CloudShareLinkService。
 *
 * `forRoot(invitation, security)` 注入邀请配置切片（过期天数）与加密配置切片
 * （对称密钥，供 `SecretCryptoService` 使用），分别由 server-main 的
 * AppConfig.invitation / AppConfig.security 提供。
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
  static forRoot(
    invitation: AppConfigInvitation,
    security: SecurityConfig,
  ): DynamicModule {
    return {
      module: MainModule,
      imports: [
        TxTypeOrmModule.forFeature([
          AppUser,
          Organization,
          Membership,
          Invitation,
          Conversation,
          ConversationMember,
          Message,
          SkillPackage,
          SkillVersion,
          CloudNode,
          CloudNodeGrant,
          CloudShareLink,
          Device,
          DeviceAuthRequest,
          EmailVerification,
          OrgModelConfig,
        ]),
      ],
      providers: [
        UserService,
        OrgService,
        OrgModelConfigService,
        MembershipService,
        InvitationService,
        MessageService,
        ConversationService,
        DeviceAuthService,
        DeviceService,
        EmailVerificationService,
        PresenceService,
        DevicePresenceService,
        SkillPackageService,
        SkillMarketService,
        CloudNodeService,
        CloudNodeGrantService,
        CloudDriveService,
        CloudShareLinkService,
        SecretCryptoService,
        { provide: INVITATION_CONFIG, useValue: invitation },
        { provide: SECURITY_CONFIG, useValue: security },
      ],
      exports: [
        UserService,
        OrgService,
        OrgModelConfigService,
        MembershipService,
        InvitationService,
        MessageService,
        ConversationService,
        DeviceAuthService,
        DeviceService,
        EmailVerificationService,
        PresenceService,
        DevicePresenceService,
        SkillPackageService,
        SkillMarketService,
        CloudNodeService,
        CloudNodeGrantService,
        CloudDriveService,
        CloudShareLinkService,
        SecretCryptoService,
      ],
    };
  }
}
