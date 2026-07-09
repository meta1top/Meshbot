import {
  CLOUD_TOKEN_PORT,
  RUNTIME_CONTEXT_PORT,
  AccountContextService,
} from "@meshbot/lib-agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { QUICK_ASSISTANT_DEFAULT_NAME } from "@meshbot/types-agent";
import { Global, Module } from "@nestjs/common";
import { AuthModule } from "./auth.module";
import { Setting } from "./entities/setting.entity";
import { CloudIdentityService } from "./services/cloud-identity.service";
import { QUICK_ASSISTANT_NAME_KEY } from "./services/quick-assistant.service";
import { SettingService } from "./services/setting.service";
import type { CloudTokenPort, RuntimeContextPort } from "@meshbot/lib-agent";

/**
 * @Global RuntimeContextModule：为 AgentModule 提供 RUNTIME_CONTEXT_PORT / CLOUD_TOKEN_PORT 绑定。
 *
 * 两个端口的 resolve() 都在账号上下文内被调（GraphService.run / ModelResolver.resolveModel 内），
 * AccountContextService.getOrThrow() 安全。全 best-effort：displayName 无身份返 null、
 * language/timezone 无设置返 null、device token 未登录/查无身份返 null（云模型请求带空 Bearer，
 * 由网关侧鉴权拒绝）。
 */
@Global()
@Module({
  imports: [
    // SettingService 需要 Setting 仓库
    TxTypeOrmModule.forFeature([Setting]),
    // CloudIdentityService 由 AuthModule export
    AuthModule,
  ],
  providers: [
    SettingService,
    {
      provide: RUNTIME_CONTEXT_PORT,
      useFactory: (
        account: AccountContextService,
        cloudIdentity: CloudIdentityService,
        setting: SettingService,
      ): RuntimeContextPort => ({
        async resolve() {
          const cloudUserId = account.getOrThrow();
          const [identity, language, timezone, quickName] = await Promise.all([
            cloudIdentity.get(cloudUserId).catch(() => null),
            setting.get("language").catch(() => null),
            setting.get("timezone").catch(() => null),
            setting.get(QUICK_ASSISTANT_NAME_KEY).catch(() => null),
          ]);
          return {
            displayName: identity?.displayName ?? null,
            language,
            timezone,
            quickAssistantName: quickName ?? QUICK_ASSISTANT_DEFAULT_NAME,
          };
        },
      }),
      inject: [AccountContextService, CloudIdentityService, SettingService],
    },
    {
      provide: CLOUD_TOKEN_PORT,
      useFactory: (
        account: AccountContextService,
        cloudIdentity: CloudIdentityService,
      ): CloudTokenPort => ({
        async resolve() {
          const cloudUserId = account.getOrThrow();
          const identity = await cloudIdentity
            .get(cloudUserId)
            .catch(() => null);
          return identity?.deviceToken ?? null;
        },
      }),
      inject: [AccountContextService, CloudIdentityService],
    },
  ],
  exports: [RUNTIME_CONTEXT_PORT, CLOUD_TOKEN_PORT],
})
export class RuntimeContextModule {}
