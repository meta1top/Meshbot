import { DISPATCH_SUBAGENT_PORT } from "@meshbot/lib-agent";
import { Global, Module } from "@nestjs/common";
import { DispatchSubagentService } from "./services/dispatch-subagent.service";
import { SessionModule } from "./session.module";

/**
 * @Global 绑定 DISPATCH_SUBAGENT_PORT → DispatchSubagentService。
 * imports SessionModule 以获得 SessionService / SessionMessageService / RunnerService
 * （SessionModule exports 了这三者）。
 * AccountContextService 由 AgentModule 内的 AccountContextModule（@Global）全局提供。
 * EventEmitter2 由 EventEmitterModule.forRoot()（app.module @Global）全局提供。
 */
@Global()
@Module({
  imports: [SessionModule],
  providers: [
    DispatchSubagentService,
    { provide: DISPATCH_SUBAGENT_PORT, useExisting: DispatchSubagentService },
  ],
  exports: [DISPATCH_SUBAGENT_PORT, DispatchSubagentService],
})
export class DispatchSubagentModule {}
