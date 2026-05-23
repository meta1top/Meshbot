import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { MeshbotConfigModule } from "./config/meshbot-config.module";
import { MeshbotConfigService } from "./config/meshbot-config.service";
import { GraphService } from "./graph/graph.service";
import { PromptService } from "./prompt/prompt.service";
import { ToolRegistry } from "./tools/tool-registry";

@Module({
  imports: [DiscoveryModule, MeshbotConfigModule, EventEmitterModule.forRoot()],
  providers: [
    ToolRegistry,
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
