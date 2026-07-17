import {
  AGENT_RENAME_PORT,
  CLOUD_TOKEN_PORT,
  MODEL_CONFIG_READ_PORT,
  RUNTIME_CONTEXT_PORT,
  AccountContextService,
  AgentContextService,
} from "@meshbot/lib-agent";
import { TxTypeOrmModule } from "@meshbot/common";
import {
  DEFAULT_AGENT_NAME,
  QUICK_ASSISTANT_EVENTS,
  type QuickAssistantRenamedEvent,
} from "@meshbot/types-agent";
import { Global, Module } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { AgentsModule } from "./agents.module";
import { AuthModule } from "./auth.module";
import { Setting } from "./entities/setting.entity";
import { AgentService } from "./services/agent.service";
import { CloudIdentityService } from "./services/cloud-identity.service";
import { createModelConfigReadPort } from "./services/model-config-read.adapter";
import { ModelConfigService } from "./services/model-config.service";
import { SettingService } from "./services/setting.service";
import { SessionModule } from "./session.module";
import type {
  AgentRenamePort,
  CloudTokenPort,
  RuntimeContextPort,
} from "@meshbot/lib-agent";

/**
 * AGENT_RENAME_PORT 工厂逻辑：抽成具名函数便于单测（无需起 Nest 容器，同
 * ImContextModule.createImContextPort 范式）。
 *
 * 「随手问」面板绑定的是账号默认 Agent（`AgentService.ensureDefault()` 语义：
 * list() 第一个，零 agent 时创建）。只有被改名的 agentId 恰好是默认 Agent 时才
 * emit `QUICK_ASSISTANT_EVENTS.renamed`，改非默认 Agent 不应刷新随手问面板标题。
 * `ensureDefault()` 此处必然命中「已有 agent」分支（agentId 刚被 update 过，账号下
 * 至少有一个 agent），不会触发建默认 agent 的副作用。
 */
export function createAgentRenamePort(
  agents: AgentService,
  emitter: EventEmitter2,
): AgentRenamePort {
  return {
    async rename(agentId, name) {
      await agents.update(agentId, { name });
      const defaultAgent = await agents.ensureDefault();
      if (defaultAgent.id === agentId) {
        emitter.emit(QUICK_ASSISTANT_EVENTS.renamed, {
          name,
        } satisfies QuickAssistantRenamedEvent);
      }
    },
  };
}

/**
 * @Global RuntimeContextModule：为 AgentModule 提供 RUNTIME_CONTEXT_PORT / CLOUD_TOKEN_PORT /
 * MODEL_CONFIG_READ_PORT / AGENT_RENAME_PORT 绑定。
 *
 * 各端口的 resolve()/resolveActive()/resolveById() 都在账号上下文内被调
 * （GraphService.run / ModelResolver.resolveModel()·getTitleModel() 内），
 * AccountContextService.getOrThrow() 安全。全 best-effort：displayName 无身份返 null、
 * language/timezone 无设置返 null、device token 未登录/查无身份返 null（云模型请求带空 Bearer，
 * 由网关侧鉴权拒绝）；当前 agentId 缺失或已删除时 agentName 兜底默认名、agentSystemPrompt 返 null
 * （buildPersonaMessage 据此省略人格正文段）。
 * MODEL_CONFIG_READ_PORT 委托 ModelConfigService 合并视图（本地 local 行 + 云端读时
 * 代理 cloud 行）——修复 Critical C-1：旧实现直读 sqlite model_configs 表，云端模型行
 * （不落库）运行时永远解析不出。
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
    // ModelConfigService 由 SessionModule export（模型配置合并视图）
    SessionModule,
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
      useFactory: createAgentRenamePort,
      inject: [AgentService, EventEmitter2],
    },
    {
      provide: MODEL_CONFIG_READ_PORT,
      useFactory: createModelConfigReadPort,
      inject: [ModelConfigService],
    },
  ],
  exports: [
    RUNTIME_CONTEXT_PORT,
    CLOUD_TOKEN_PORT,
    AGENT_RENAME_PORT,
    MODEL_CONFIG_READ_PORT,
  ],
})
export class RuntimeContextModule {}
