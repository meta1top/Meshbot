import { AgentModule } from "@meshbot/lib-agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { AgentsModule } from "./agents.module";
import { CheckpointerCleanupService } from "./services/checkpointer-cleanup.service";
import { ContextCompactor } from "./services/context-compactor.service";
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
import { ModelConfigSyncService } from "./services/model-config-sync.service";
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
    AgentsModule,
    AuthModule,
  ],
  controllers: [SessionController, StatsController, SuggestionController],
  providers: [
    CheckpointerCleanupService,
    ContextCompactor,
    SessionService,
    RunnerService,
    SessionGateway,
    LlmCallService,
    SessionMessageService,
    SessionTitleService,
    ModelConfigService,
    ModelConfigSyncService,
    StatsService,
    SuggestionService,
    ScheduleExecutor,
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
