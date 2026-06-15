import { Global, Module } from "@nestjs/common";
import { AccountContextService } from "./account-context.service";

/** 全局账号上下文（AsyncLocalStorage 单例），供 libs/agent 与 server-agent 共享同一实例。 */
@Global()
@Module({
  providers: [AccountContextService],
  exports: [AccountContextService],
})
export class AccountContextModule {}
