import { Module } from "@nestjs/common";

import { CloudImController } from "./controllers/cloud-im.controller";
import { SidebarController } from "./controllers/sidebar.controller";
import { AuthModule } from "./auth.module";
import { SessionModule } from "./session.module";
import { CloudImService } from "./services/cloud-im.service";
import { SidebarService } from "./services/sidebar.service";
import { EventsGateway } from "./ws/events.gateway";

/**
 * IM 模块：注册 EventsGateway（本地事件总线 WS 网关）、CloudImService（REST 代理编排）、
 * CloudImController / SidebarController（薄控制器）。
 *
 * ImRelayClientService 由 AuthModule 提供并导出（OnModuleInit 启动即连）；
 * 此处 import AuthModule 即可复用。SessionModule 提供 SessionService 等。
 */
@Module({
  imports: [AuthModule, SessionModule],
  controllers: [CloudImController, SidebarController],
  providers: [CloudImService, EventsGateway, SidebarService],
  exports: [CloudImService],
})
export class ImModule {}
