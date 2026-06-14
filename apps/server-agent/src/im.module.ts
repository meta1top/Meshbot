import { Module } from "@nestjs/common";

import { CloudImController } from "./controllers/cloud-im.controller";
import { AuthModule } from "./auth.module";
import { CloudImService } from "./services/cloud-im.service";
import { ImGateway } from "./ws/im.gateway";

/**
 * IM 模块：注册 ImGateway（本地 WS 网关）、CloudImService（REST 代理编排）
 * 与 CloudImController（薄控制器）。
 *
 * ImRelayClientService 由 AuthModule 提供并导出（OnModuleInit 启动即连，
 * OnModuleDestroy 销毁断连；CloudAuthService.login / logout 调用 connect / disconnect）。
 * 此处直接 import AuthModule 即可复用，无循环依赖。
 */
@Module({
  imports: [AuthModule],
  controllers: [CloudImController],
  providers: [CloudImService, ImGateway],
})
export class ImModule {}
