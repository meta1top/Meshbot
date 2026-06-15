import { Global, Module } from "@nestjs/common";
import { ScopedRepositoryFactory } from "./scoped-repository.factory";

/**
 * server-agent 账号基础设施（全局）：作用域仓库工厂。
 * AccountContextService 由 libs/agent 的 @Global AccountContextModule 提供（AgentModule 已导入），
 * 此处不重复 provide，确保全进程同一 ALS 单例。
 */
@Global()
@Module({
  providers: [ScopedRepositoryFactory],
  exports: [ScopedRepositoryFactory],
})
export class AccountModule {}
