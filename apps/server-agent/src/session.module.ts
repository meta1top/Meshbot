import { AgentModule } from "@meshbot/agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { SessionController } from "./controllers/session.controller";
import { LlmCall } from "./entities/llm-call.entity";
import { PendingMessage } from "./entities/pending-message.entity";
import { Session } from "./entities/session.entity";
import { SessionMessage } from "./entities/session-message.entity";
import { CheckpointerCleanupService } from "./services/checkpointer-cleanup.service";
import { LlmCallService } from "./services/llm-call.service";
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
    ]),
    AgentModule,
    AuthModule,
  ],
  controllers: [SessionController],
  providers: [
    CheckpointerCleanupService,
    SessionService,
    RunnerService,
    SessionGateway,
    LlmCallService,
    SessionMessageService,
    SessionTitleService,
  ],
  exports: [
    CheckpointerCleanupService,
    SessionService,
    RunnerService,
    LlmCallService,
    SessionMessageService,
    SessionTitleService,
  ],
})
export class SessionModule {}
