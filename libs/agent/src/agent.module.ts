import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { AccountContextModule } from "./account/account-context.module";
import { MeshbotConfigModule } from "./config/meshbot-config.module";
import { AccountGraphProvider } from "./graph/account-graph.provider";
import { ContextBuilder } from "./graph/context-builder";
import { GraphRunner } from "./graph/graph-runner.service";
import { GraphService } from "./graph/graph.service";
import { ModelResolver } from "./graph/model-resolver.service";
import { ThreadStateService } from "./graph/thread-state.service";
import { PromptService } from "./prompt/prompt.service";
import { McpService } from "./mcp/mcp.service";
import { MemoryService } from "./memory/memory.service";
import { SkillService } from "./skills/skill.service";
import { ToolRegistry } from "./tools/tool-registry";
import { FileStateService } from "./tools/builtins/file-state.service";
import { BashTool } from "./tools/builtins/bash.tool";
import { ReadFileTool } from "./tools/builtins/read-file.tool";
import { WriteFileTool } from "./tools/builtins/write-file.tool";
import { EditFileTool } from "./tools/builtins/edit-file.tool";
import { GrepTool } from "./tools/builtins/grep.tool";
import { GlobTool } from "./tools/builtins/glob.tool";
import { DateTool } from "./tools/builtins/date.tool";
import { MemoryAddTool } from "./tools/builtins/memory-add.tool";
import { MemoryCoreWriteTool } from "./tools/builtins/memory-core-write.tool";
import { MemoryDeleteTool } from "./tools/builtins/memory-delete.tool";
import { MemorySearchTool } from "./tools/builtins/memory-search.tool";
import { ScheduleCreateTool } from "./tools/builtins/schedule-create.tool";
import { ScheduleDeleteTool } from "./tools/builtins/schedule-delete.tool";
import { ScheduleListTool } from "./tools/builtins/schedule-list.tool";
import { SkillInstallTool } from "./tools/builtins/skill-install.tool";
import { SkillListTool } from "./tools/builtins/skill-list.tool";
import { SkillLoadTool } from "./tools/builtins/skill-load.tool";
import { RenameQuickAssistantTool } from "./tools/builtins/rename-quick-assistant.tool";
import { SkillPublishTool } from "./tools/builtins/skill-publish.tool";
import { SkillSearchMarketTool } from "./tools/builtins/skill-search-market.tool";
import { SkillUninstallTool } from "./tools/builtins/skill-uninstall.tool";

@Module({
  // EventEmitterModule.forRoot() 在 app 层（apps/server-agent app.module）也调；
  // NestJS 对同一个 module 类的重复 forRoot 调用做去重，最终全局只有一个
  // EventEmitter2 实例。本处仍然 import 是为了 libs/agent 的独立集成测试
  // （tests/integration/agent.module.test.ts）能解析 GraphService 的依赖。
  imports: [
    AccountContextModule,
    DiscoveryModule,
    MeshbotConfigModule,
    EventEmitterModule.forRoot(),
  ],
  providers: [
    ToolRegistry,
    FileStateService,
    BashTool,
    ReadFileTool,
    WriteFileTool,
    EditFileTool,
    GrepTool,
    GlobTool,
    DateTool,
    ScheduleCreateTool,
    ScheduleListTool,
    ScheduleDeleteTool,
    SkillService,
    SkillListTool,
    SkillLoadTool,
    SkillInstallTool,
    SkillUninstallTool,
    SkillSearchMarketTool,
    SkillPublishTool,
    RenameQuickAssistantTool,
    MemoryService,
    MemoryCoreWriteTool,
    MemoryAddTool,
    MemorySearchTool,
    MemoryDeleteTool,
    McpService,
    PromptService,
    ModelResolver,
    AccountGraphProvider,
    ContextBuilder,
    ThreadStateService,
    GraphRunner,
    GraphService,
  ],
  exports: [
    GraphService,
    PromptService,
    ToolRegistry,
    SkillService,
    McpService,
    MeshbotConfigModule,
  ],
})
export class AgentModule {}
