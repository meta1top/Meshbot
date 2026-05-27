import { AgentModule } from "@meshbot/agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { SessionController } from "./controllers/session.controller";
import { StatsController } from "./controllers/stats.controller";
import { SuggestionController } from "./controllers/suggestion.controller";
import { StatsService } from "./services/stats.service";
import { SuggestionService } from "./services/suggestion.service";
import { LlmCall } from "./entities/llm-call.entity";
import { ModelConfig } from "./entities/model-config.entity";
import { PendingMessage } from "./entities/pending-message.entity";
import { Session } from "./entities/session.entity";
import { SessionMessage } from "./entities/session-message.entity";
import { CheckpointerCleanupService } from "./services/checkpointer-cleanup.service";
import { ContextCompactor } from "./services/context-compactor.service";
import { LlmCallService } from "./services/llm-call.service";
import { ModelConfigService } from "./services/model-config.service";
import { SessionMessageService } from "./services/session-message.service";
import { RunnerService } from "./services/runner.service";
import { SessionService } from "./services/session.service";
import { SessionTitleService } from "./services/session-title.service";
import { AuthModule } from "./auth.module";
import { SessionGateway } from "./ws/session.gateway";

/** 会话模块：聚合会话相关 Entity / Service / Controller / Gateway。 */
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
    StatsService,
    SuggestionService,
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
