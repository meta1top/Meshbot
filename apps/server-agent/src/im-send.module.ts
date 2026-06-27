import { IM_SEND_PORT } from "@meshbot/agent";
import { Global, Module } from "@nestjs/common";
import { AuthModule } from "./auth.module";
import { ConfirmationService } from "./services/confirmation.service";
import { ImSendService } from "./services/im-send.service";

/**
 * @Global IM 发送模块：绑定 IM_SEND_PORT 到 ImSendService，并导出 ConfirmationService
 * 供 confirm 端点 resolve。AuthModule 提供 ImRelayClientService。
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [
    ConfirmationService,
    ImSendService,
    { provide: IM_SEND_PORT, useExisting: ImSendService },
  ],
  exports: [IM_SEND_PORT, ConfirmationService],
})
export class ImSendModule {}
