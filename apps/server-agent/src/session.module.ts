import { AgentModule } from "@meshbot/agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { CheckpointerCleanupService } from "./services/checkpointer-cleanup.service";
import { ContextCompactor } from "./services/context-compactor.service";
import { CronJobController } from "./controllers/cron-job.controller";
import { SessionController } from "./controllers/session.controller";
import { StatsController } from "./controllers/stats.controller";
import { SuggestionController } from "./controllers/suggestion.controller";
import { CronJob } from "./entities/cron-job.entity";
import { LlmCall } from "./entities/llm-call.entity";
import { ModelConfig } from "./entities/model-config.entity";
import { PendingMessage } from "./entities/pending-message.entity";
import { Session } from "./entities/session.entity";
import { SessionMessage } from "./entities/session-message.entity";
import { LlmCallService } from "./services/llm-call.service";
import { ModelConfigService } from "./services/model-config.service";
import { RunnerService } from "./services/runner.service";
import { ScheduleExecutor } from "./services/schedule-executor.service";
import { ScheduleService } from "./services/schedule.service";
import { SessionMessageService } from "./services/session-message.service";
import { SessionService } from "./services/session.service";
import { SessionTitleService } from "./services/session-title.service";
import { StatsService } from "./services/stats.service";
import { SuggestionService } from "./services/suggestion.service";
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
      CronJob,
    ]),
    AgentModule,
    AuthModule,
  ],
  controllers: [
    SessionController,
    StatsController,
    SuggestionController,
    CronJobController,
  ],
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
    ScheduleService,
    ScheduleExecutor,
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
    ScheduleService,
  ],
})
export class SessionModule {}
