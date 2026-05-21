import { AgentModule } from "@meshbot/agent";
import { TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { SessionController } from "./controllers/session.controller";
import { PendingMessage } from "./entities/pending-message.entity";
import { Session } from "./entities/session.entity";
import { RunnerService } from "./services/runner.service";
import { SessionService } from "./services/session.service";
import { AuthModule } from "./auth.module";
import { SessionGateway } from "./ws/session.gateway";

/** 会话模块：聚合会话相关 Entity / Service / Controller / Gateway。 */
@Module({
  imports: [
    TxTypeOrmModule.forFeature([Session, PendingMessage]),
    AgentModule,
    AuthModule,
  ],
  controllers: [SessionController],
  providers: [SessionService, RunnerService, SessionGateway],
  exports: [SessionService, RunnerService],
})
export class SessionModule {}
