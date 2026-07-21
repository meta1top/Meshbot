import { Global, Module } from "@nestjs/common";
import { AgentContextService } from "./agent-context.service";

/**
 * 全局 Agent 上下文（AsyncLocalStorage 单例），供 libs/agent 与 server-agent 共享同一实例。
 * 与 {@link AccountContextModule} 同范式：MeshbotConfigService 等下游 Service 无需显式
 * import 本模块即可注入 AgentContextService（只要本模块在整棵模块图里被加载一次）。
 */
@Global()
@Module({
  providers: [AgentContextService],
  exports: [AgentContextService],
})
export class AgentContextModule {}
