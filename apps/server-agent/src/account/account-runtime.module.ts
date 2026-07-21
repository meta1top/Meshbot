import { Global, Module } from "@nestjs/common";
import { AgentModule } from "@meshbot/lib-agent";
import { AgentsModule } from "../agents.module";
import { AuthModule } from "../auth.module";
import { AccountBootstrapService } from "./account-bootstrap.service";
import { AccountRuntimeRegistry } from "./account-runtime.registry";

/**
 * @Global AccountRuntimeModule：让 AccountRuntimeRegistry 可被任意模块注入，
 * 无需显式 import 本模块（解除 AuthModule 与本模块的循环依赖风险）。
 *
 * AgentsModule：AccountRuntimeRegistry 需要 AgentService.ensureDefault() 兜底
 * 取默认 Agent（登录时仅保证至少有一个 Agent 存在；MCP 已改为按 Agent 懒加载
 * ——不再在这里预热，见 McpService.ensureAgent）。
 */
@Global()
@Module({
  imports: [AgentModule, AgentsModule, AuthModule],
  providers: [AccountRuntimeRegistry, AccountBootstrapService],
  exports: [AccountRuntimeRegistry],
})
export class AccountRuntimeModule {}
