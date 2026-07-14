import {
  AGENT_RENAME_PORT,
  CLOUD_TOKEN_PORT,
  RUNTIME_CONTEXT_PORT,
  AccountContextService,
  AgentContextService,
} from "@meshbot/lib-agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { DEFAULT_AGENT_NAME } from "@meshbot/types-agent";
import { Global, Module } from "@nestjs/common";
import { AgentsModule } from "./agents.module";
import { AuthModule } from "./auth.module";
import { Setting } from "./entities/setting.entity";
import { AgentService } from "./services/agent.service";
import { CloudIdentityService } from "./services/cloud-identity.service";
import { SettingService } from "./services/setting.service";
import type {
  AgentRenamePort,
  CloudTokenPort,
  RuntimeContextPort,
} from "@meshbot/lib-agent";

/**
 * @Global RuntimeContextModule：为 AgentModule 提供 RUNTIME_CONTEXT_PORT / CLOUD_TOKEN_PORT /
 * AGENT_RENAME_PORT 绑定。
 *
 * 两个端口的 resolve() 都在账号上下文内被调（GraphService.run / ModelResolver.resolveModel 内），
 * AccountContextService.getOrThrow() 安全。全 best-effort：displayName 无身份返 null、
 * language/timezone 无设置返 null、device token 未登录/查无身份返 null（云模型请求带空 Bearer，
 * 由网关侧鉴权拒绝）；当前 agentId 缺失或已删除时 agentName 兜底默认名、agentSystemPrompt 返 null
 * （buildPersonaMessage 据此省略人格正文段）。
 */
@Global()
@Module({
  imports: [
    // SettingService 需要 Setting 仓库
    TxTypeOrmModule.forFeature([Setting]),
    // CloudIdentityService 由 AuthModule export
    AuthModule,
    // AgentService 由 AgentsModule export（当前 Agent 的 name / systemPrompt）
    AgentsModule,
  ],
  providers: [
    SettingService,
    {
      provide: RUNTIME_CONTEXT_PORT,
      useFactory: (
        account: AccountContextService,
        agentCtx: AgentContextService,
        cloudIdentity: CloudIdentityService,
        setting: SettingService,
        agents: AgentService,
      ): RuntimeContextPort => ({
        async resolve() {
          const cloudUserId = account.getOrThrow();
          const agentId = agentCtx.get();
          const [identity, language, timezone, agent] = await Promise.all([
            cloudIdentity.get(cloudUserId).catch(() => null),
            setting.get("language").catch(() => null),
            setting.get("timezone").catch(() => null),
            agentId ? agents.findOrNull(agentId).catch(() => null) : null,
          ]);
          return {
            displayName: identity?.displayName ?? null,
            language,
            timezone,
            agentName: agent?.name ?? DEFAULT_AGENT_NAME,
            agentSystemPrompt: agent?.systemPrompt ?? null,
          };
        },
      }),
      inject: [
        AccountContextService,
        AgentContextService,
        CloudIdentityService,
        SettingService,
        AgentService,
      ],
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
    {
      provide: AGENT_RENAME_PORT,
      useFactory: (agents: AgentService): AgentRenamePort => ({
        async rename(agentId, name) {
          await agents.update(agentId, { name });
        },
      }),
      inject: [AgentService],
    },
  ],
  exports: [RUNTIME_CONTEXT_PORT, CLOUD_TOKEN_PORT, AGENT_RENAME_PORT],
})
export class RuntimeContextModule {}
