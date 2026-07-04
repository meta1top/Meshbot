import { Global, Module } from "@nestjs/common";
import { AuthModule } from "./auth.module";
import { ImAgentSessionModule } from "./im-agent-session.module";
import { ImModule } from "./im.module";
import { AgentInboxService } from "./services/agent-inbox.service";
import { SessionModule } from "./session.module";

/**
 * @Global Agent 入站消息模块：绑定 AgentInboxService（监听 relay 下发的
 * `im.agent_inbound`，以及重连/启动补处理）。imports SessionModule 获得
 * SessionService / RunnerService / SessionMessageService；AuthModule 获得
 * ImRelayClientService；ImAgentSessionModule 获得 ImAgentSessionService（会话
 * 映射 + append/处理游标）；ImModule 获得 CloudImService（补处理枚举会话 +
 * 拉历史消息）。AccountContextService 由 AgentModule 内的 AccountContextModule
 * （@Global）全局提供；EventEmitter2 由 EventEmitterModule.forRoot()
 * （app.module @Global）全局提供。
 */
@Global()
@Module({
  imports: [SessionModule, AuthModule, ImAgentSessionModule, ImModule],
  providers: [AgentInboxService],
  exports: [AgentInboxService],
})
export class AgentInboxModule {}
