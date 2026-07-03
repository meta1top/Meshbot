import { Global, Module } from "@nestjs/common";
import { AuthModule } from "./auth.module";
import { ImAgentSessionModule } from "./im-agent-session.module";
import { AgentInboxService } from "./services/agent-inbox.service";
import { SessionModule } from "./session.module";

/**
 * @Global Agent 入站消息模块：绑定 AgentInboxService（监听 relay 下发的
 * `im.agent_inbound`）。imports SessionModule 获得 SessionService /
 * RunnerService / SessionMessageService；AuthModule 获得 ImRelayClientService；
 * ImAgentSessionModule 获得 ImAgentSessionService（会话映射 + 处理游标）。
 * AccountContextService 由 AgentModule 内的 AccountContextModule（@Global）
 * 全局提供；EventEmitter2 由 EventEmitterModule.forRoot()（app.module @Global）
 * 全局提供。
 */
@Global()
@Module({
  imports: [SessionModule, AuthModule, ImAgentSessionModule],
  providers: [AgentInboxService],
  exports: [AgentInboxService],
})
export class AgentInboxModule {}
