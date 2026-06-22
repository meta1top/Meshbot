import { RUNTIME_CONTEXT_PORT, AccountContextService } from "@meshbot/agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { Global, Module } from "@nestjs/common";
import { AuthModule } from "./auth.module";
import { Setting } from "./entities/setting.entity";
import { CloudIdentityService } from "./services/cloud-identity.service";
import { SettingService } from "./services/setting.service";
import type { RuntimeContextPort } from "@meshbot/agent";

/**
 * @Global RuntimeContextModule：为 AgentModule 的 GraphService 提供 RUNTIME_CONTEXT_PORT 绑定。
 *
 * resolve() 在账号上下文内被调（GraphService.run 内），AccountContextService.getOrThrow() 安全。
 * 全 best-effort：displayName 无身份返 null、language/timezone 无设置返 null。
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
          const [identity, language, timezone] = await Promise.all([
            cloudIdentity.get(cloudUserId).catch(() => null),
            setting.get("language").catch(() => null),
            setting.get("timezone").catch(() => null),
          ]);
          return {
            displayName: identity?.displayName ?? null,
            language,
            timezone,
          };
        },
      }),
      inject: [AccountContextService, CloudIdentityService, SettingService],
    },
  ],
  exports: [RUNTIME_CONTEXT_PORT],
})
export class RuntimeContextModule {}
