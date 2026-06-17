import { Module } from "@nestjs/common";

import { CloudImController } from "./controllers/cloud-im.controller";
import { ImAgentController } from "./controllers/im-agent.controller";
import { AuthModule } from "./auth.module";
import { SessionModule } from "./session.module";
import { CloudImService } from "./services/cloud-im.service";
import { ImAgentService } from "./services/im-agent.service";
import { ImGateway } from "./ws/im.gateway";

/**
 * IM 模块：注册 ImGateway（本地 WS 网关）、CloudImService（REST 代理编排）
 * 与 CloudImController（薄控制器）。
 *
 * ImRelayClientService 由 AuthModule 提供并导出（OnModuleInit 启动即连，
 * OnModuleDestroy 销毁断连；CloudAuthService.login / logout 调用 connect / disconnect）。
 * 此处直接 import AuthModule 即可复用，无循环依赖。
 *
 * SessionModule 提供 SessionService + RunnerService，供 ImAgentService 编排伴生 Agent。
 * CloudIdentityService 来自 AuthModule（已导出）；AccountContextService 全局模块。
 */
@Module({
  imports: [AuthModule, SessionModule],
  controllers: [CloudImController, ImAgentController],
  providers: [CloudImService, ImGateway, ImAgentService],
})
export class ImModule {}
