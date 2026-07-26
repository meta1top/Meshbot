import { MCP_CONFIRM_PORT } from "@meshbot/lib-agent";
import { Global, Module } from "@nestjs/common";
import { McpConfirmService } from "./services/mcp-confirm.service";

/**
 * @Global MCP 安装确认模块：绑定 MCP_CONFIRM_PORT 到 McpConfirmService。
 * ConfirmationService / AccountContextService 由全局模块提供（ImSendModule
 * @Global 导出唯一 ConfirmationService 实例，此处注入同一个，勿重复 provide——
 * 单例命门，见 ConfirmationService 类注释）。
 */
@Global()
@Module({
  providers: [
    McpConfirmService,
    { provide: MCP_CONFIRM_PORT, useExisting: McpConfirmService },
  ],
  exports: [MCP_CONFIRM_PORT],
})
export class McpConfirmModule {}
