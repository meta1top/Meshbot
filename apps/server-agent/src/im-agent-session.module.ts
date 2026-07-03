import { TxTypeOrmModule } from "@meshbot/common";
import { Module } from "@nestjs/common";
import { ImAgentSession } from "./entities/im-agent-session.entity";
import { ImAgentSessionService } from "./services/im-agent-session.service";

/** IM Agent 会话映射模块：聚合会话映射相关 Entity / Service。 */
@Module({
  imports: [TxTypeOrmModule.forFeature([ImAgentSession])],
  providers: [ImAgentSessionService],
  exports: [ImAgentSessionService],
})
export class ImAgentSessionModule {}
