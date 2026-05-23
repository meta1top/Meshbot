import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { MeshbotConfigModule } from "./config/meshbot-config.module";
import { MeshbotConfigService } from "./config/meshbot-config.service";
import { GraphService } from "./graph/graph.service";
import { PromptService } from "./prompt/prompt.service";
import { ToolRegistry } from "./tools/tool-registry";
import { BashTool } from "./tools/builtins/bash.tool";
import { DateTool } from "./tools/builtins/date.tool";

@Module({
  // EventEmitterModule.forRoot() 在 app 层（apps/server-agent app.module）也调；
  // NestJS 对同一个 module 类的重复 forRoot 调用做去重，最终全局只有一个
  // EventEmitter2 实例。本处仍然 import 是为了 libs/agent 的独立集成测试
  // （tests/integration/agent.module.test.ts）能解析 GraphService 的依赖。
  imports: [DiscoveryModule, MeshbotConfigModule, EventEmitterModule.forRoot()],
  providers: [
    ToolRegistry,
    BashTool,
    DateTool,
    {
      provide: PromptService,
      useFactory: (configService: MeshbotConfigService) => {
        return new PromptService(configService.getMeshbotDir());
      },
      inject: [MeshbotConfigService],
    },
    GraphService,
  ],
  exports: [GraphService, PromptService, ToolRegistry],
})
export class AgentModule {}
