import { AgentModule } from "@meshbot/agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { SessionController } from "./controllers/session.controller";
import { LlmCall } from "./entities/llm-call.entity";
import { PendingMessage } from "./entities/pending-message.entity";
import { Session } from "./entities/session.entity";
import { LlmCallService } from "./services/llm-call.service";
import { RunnerService } from "./services/runner.service";
import { SessionService } from "./services/session.service";
import { AuthModule } from "./auth.module";
import { SessionGateway } from "./ws/session.gateway";

/** 会话模块：聚合会话相关 Entity / Service / Controller / Gateway。 */
@Module({
  imports: [
    TxTypeOrmModule.forFeature([Session, PendingMessage, LlmCall]),
    AgentModule,
    AuthModule,
  ],
  controllers: [SessionController],
  providers: [SessionService, RunnerService, SessionGateway, LlmCallService],
  exports: [SessionService, RunnerService, LlmCallService],
})
export class SessionModule {}
