import { Module } from "@nestjs/common";
import { AgentsModule } from "./agents.module";
import { QuickAssistantController } from "./controllers/quick-assistant.controller";

/**
 * 随手问命名模块：只剩 REST 端点（名字读写代理到默认 Agent 的 name，见
 * `QuickAssistantController`）。改名 tool 已迁到 `rename_agent`（走
 * `AGENT_RENAME_PORT`，绑定在 `RuntimeContextModule`），本模块不再需要
 * `@Global` 暴露端口给 `AgentModule` 内的工具。
 */
@Module({
  imports: [AgentsModule],
  controllers: [QuickAssistantController],
})
export class QuickAssistantModule {}
