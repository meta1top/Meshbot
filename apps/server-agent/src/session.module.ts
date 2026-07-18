import { AgentModule } from "@meshbot/lib-agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { Module, forwardRef } from "@nestjs/common";
import { AgentsModule } from "./agents.module";
import { AgentCloudSyncService } from "./services/agent-cloud-sync.service";
import { CheckpointerCleanupService } from "./services/checkpointer-cleanup.service";
import { CloudModelConfigProxyService } from "./services/cloud-model-config-proxy.service";
import { ContextCompactor } from "./services/context-compactor.service";
import { RemoteAgentsController } from "./controllers/remote-agents.controller";
import { SessionController } from "./controllers/session.controller";
import { StatsController } from "./controllers/stats.controller";
import { SuggestionController } from "./controllers/suggestion.controller";
import { LlmCall } from "./entities/llm-call.entity";
import { ModelConfig } from "./entities/model-config.entity";
import { PendingMessage } from "./entities/pending-message.entity";
import { Session } from "./entities/session.entity";
import { SessionMessage } from "./entities/session-message.entity";
import { LlmCallService } from "./services/llm-call.service";
import { ModelConfigService } from "./services/model-config.service";
import { RemoteAgentsService } from "./services/remote-agents.service";
import { RemoteArtifactService } from "./services/remote-artifact.service";
import { RemoteQueryInboundService } from "./services/remote-query-inbound.service";
import { RemoteRunControlService } from "./services/remote-run-control.service";
import { RemoteRunInboundService } from "./services/remote-run-inbound.service";
import { RemoteRunRegistryService } from "./services/remote-run-registry.service";
import { RunnerService } from "./services/runner.service";
import { ScheduleExecutor } from "./services/schedule-executor.service";
import { SessionMessageService } from "./services/session-message.service";
import { SessionService } from "./services/session.service";
import { SessionTitleService } from "./services/session-title.service";
import { StatsService } from "./services/stats.service";
import { SuggestionService } from "./services/suggestion.service";
import { AuthModule } from "./auth.module";
import { SessionGateway } from "./ws/session.gateway";

/**
 * 会话模块：聚合会话相关 Entity / Service / Controller / Gateway。
 *
 * `RemoteQueryInboundService`（L2c B 侧入站查询处理器）/ `RemoteRunInboundService`
 * （L3 B 侧入站远程 run 触发处理器）/ `RemoteRunControlService`（L3 B 侧入站
 * 运行控制处理器，Phase A 仅实现 interrupt）注册于此：需要同时访问本模块的
 * `SessionService`/`RunnerService` 与 `AuthModule` 导出的
 * `ImRelayClientService`；均不导出，仅作为 `@OnEvent` 监听器存在，无其他消费方。
 * `RemoteRunRegistryService`（B 侧 streamId→sessionId 进程内注册表，Phase B
 * M3 校验真源）与两者同列，仅供模块内注入，同样不导出。
 * `AgentCloudSyncService`（计划二 2b · T3，本地 remote_enabled Agent 变更 →
 * 全量推云端对账）需要本模块 import 的 `AgentsModule`（`AgentService.list()`）
 * 与 `AuthModule`（`CloudClientService`/`CloudIdentityService`），不导出。
 * `RemoteAgentsService` + `RemoteAgentsController`（计划二 2c·A1，远程 Agent 列表）
 * 从 `AuthModule` 挪到本模块：过滤「本机 Agent」需要权威的本地 Agent 全集
 *（`AgentService.list()`），而 `AuthModule` 直接 import `AgentsModule` 会成环
 *（AuthModule → AgentsModule → forwardRef(SessionModule) → AuthModule）；本模块
 * 已同时持有 `AgentsModule` 与 `AuthModule`（`AgentCloudSyncService` 同款依赖），
 * 现成无环。不导出，仅供 Controller 注入。
 * 云端模型配置读时合并（读时合并 C）：`CloudModelConfigProxyService` 实时代理
 * 云端组织模型配置、不落库，无同步落库 provider，前端刷新走
 * `MODEL_CONFIG_EVENTS.updated` 单次 emit（见该 service 的 modelConfigChanged
 * 订阅）。
 */
@Module({
  imports: [
    TxTypeOrmModule.forFeature([
      Session,
      PendingMessage,
      LlmCall,
      SessionMessage,
      ModelConfig,
    ]),
    AgentModule,
    forwardRef(() => AgentsModule),
    AuthModule,
  ],
  controllers: [
    RemoteAgentsController,
    SessionController,
    StatsController,
    SuggestionController,
  ],
  providers: [
    AgentCloudSyncService,
    CheckpointerCleanupService,
    ContextCompactor,
    SessionService,
    RunnerService,
    SessionGateway,
    LlmCallService,
    SessionMessageService,
    SessionTitleService,
    CloudModelConfigProxyService,
    ModelConfigService,
    StatsService,
    SuggestionService,
    ScheduleExecutor,
    RemoteAgentsService,
    RemoteQueryInboundService,
    RemoteArtifactService,
    RemoteRunInboundService,
    RemoteRunControlService,
    RemoteRunRegistryService,
  ],
  exports: [
    CheckpointerCleanupService,
    ContextCompactor,
    SessionService,
    RunnerService,
    LlmCallService,
    SessionMessageService,
    SessionTitleService,
    ModelConfigService,
  ],
})
export class SessionModule {}
