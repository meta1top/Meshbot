import { Global, Module } from "@nestjs/common";
import { AgentModule } from "@meshbot/lib-agent";
import { AuthModule } from "../auth.module";
import { AccountBootstrapService } from "./account-bootstrap.service";
import { AccountRuntimeRegistry } from "./account-runtime.registry";

/**
 * @Global AccountRuntimeModule：让 AccountRuntimeRegistry 可被任意模块注入，
 * 无需显式 import 本模块（解除 AuthModule 与本模块的循环依赖风险）。
 */
@Global()
@Module({
  imports: [AgentModule, AuthModule],
  providers: [AccountRuntimeRegistry, AccountBootstrapService],
  exports: [AccountRuntimeRegistry],
})
export class AccountRuntimeModule {}
