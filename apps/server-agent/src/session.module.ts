import { TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { PendingMessage } from "./entities/pending-message.entity";
import { Session } from "./entities/session.entity";
import { SessionService } from "./services/session.service";

/** 会话模块：聚合会话相关 Entity / Service / Controller / Gateway。 */
@Module({
  imports: [TxTypeOrmModule.forFeature([Session, PendingMessage])],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
