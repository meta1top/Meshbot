import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { AccountContextModule } from "./account/account-context.module";
import { AgentContextModule } from "./account/agent-context.module";
import { MeshbotConfigModule } from "./config/meshbot-config.module";
import { AccountGraphProvider } from "./graph/account-graph.provider";
import { ContextBuilder } from "./graph/context-builder";
import { GraphRunner } from "./graph/graph-runner.service";
import { ModelResolver } from "./graph/model-resolver.service";
import { ModelRunContext } from "./graph/model-run-context";
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
import { PresentFileTool } from "./tools/builtins/present-file.tool";
import { EditFileTool } from "./tools/builtins/edit-file.tool";
import { GrepTool } from "./tools/builtins/grep.tool";
import { GlobTool } from "./tools/builtins/glob.tool";
import { DateTool } from "./tools/builtins/date.tool";
import { TodoWriteTool } from "./tools/builtins/todo-write.tool";
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
import { RenameAgentTool } from "./tools/builtins/rename-agent.tool";
import { ImUnreadOverviewTool } from "./tools/builtins/im-unread-overview.tool";
import { ImReadConversationTool } from "./tools/builtins/im-read-conversation.tool";
import { ImListMembersTool } from "./tools/builtins/im-list-members.tool";
import { ImSendMessageTool } from "./tools/builtins/im-send-message.tool";
import { AskQuestionTool } from "./tools/builtins/ask-question.tool";
import { DriveListTool } from "./tools/builtins/drive-list.tool";
import { DriveMkdirTool } from "./tools/builtins/drive-mkdir.tool";
import { DriveUploadTool } from "./tools/builtins/drive-upload.tool";
import { DriveDownloadTool } from "./tools/builtins/drive-download.tool";
import { DriveShareTool } from "./tools/builtins/drive-share.tool";
import { DriveCreateShareTool } from "./tools/builtins/drive-create-share.tool";
import { DriveFetchShareTool } from "./tools/builtins/drive-fetch-share.tool";
import { SkillPublishTool } from "./tools/builtins/skill-publish.tool";
import { SkillSearchMarketTool } from "./tools/builtins/skill-search-market.tool";
import { SkillUninstallTool } from "./tools/builtins/skill-uninstall.tool";
import { DispatchSubagentTool } from "./tools/builtins/dispatch-subagent.tool";

@Module({
  // **这里绝不能再 import `EventEmitterModule.forRoot()`。**
  //
  // 曾经这么写过，并配了一句「NestJS 对重复 forRoot 去重，全局只有一个
  // EventEmitter2」——那句话是错的：`forRoot()` 每次返回一个**新的**
  // DynamicModule 对象，NestJS 按动态模块身份去重，app 层调一次 + 这里调一次
  // ＝ 两个模块实例 ＝ **两个 EventEmitter2**。
  //
  // 它造成的故障极其难查，因为「一半功能是好的」：`@OnEvent` 由每个
  // EventEmitterModule 实例各自用 DiscoveryService 扫全部 provider 绑定，
  // 所以装饰器监听在**两个**实例上都注册（SessionGateway 照常转发到本地房间，
  // 本地 UI 全对）；而运行时 `emitter.on()`（SessionFrameForwarder 跨设备镜像）
  // 只挂在注入的那一个上。于是：RunnerService 发的 run.tool_call_args_delta
  // 走实例 A，转发器收得到；图执行（tools.node.ts）经 AccountGraphProvider 发的
  // run.tool_call_start / run.tool_call_end 走实例 B，转发器**永远收不到** ——
  // 表现为「云端观察端工具卡永远转圈、todo/present_file 特化卡不渲染，而本地
  // 一切正常」，排查了整整四轮才靠埋点钉死。
  //
  // 唯一持有方是 app 层（`apps/server-agent/src/app.module.ts`），`forRoot()` 是
  // @Global 的，本模块的 provider 直接注入即可。libs/agent 的独立集成测试自己
  // import 一份（见 tests/integration/agent.module.test.ts）。
  imports: [
    AccountContextModule,
    AgentContextModule,
    DiscoveryModule,
    MeshbotConfigModule,
  ],
  providers: [
    ToolRegistry,
    FileStateService,
    BashTool,
    ReadFileTool,
    WriteFileTool,
    PresentFileTool,
    EditFileTool,
    GrepTool,
    GlobTool,
    DateTool,
    TodoWriteTool,
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
    RenameAgentTool,
    ImUnreadOverviewTool,
    ImReadConversationTool,
    ImListMembersTool,
    ImSendMessageTool,
    AskQuestionTool,
    DispatchSubagentTool,
    DriveListTool,
    DriveMkdirTool,
    DriveUploadTool,
    DriveDownloadTool,
    DriveShareTool,
    DriveCreateShareTool,
    DriveFetchShareTool,
    MemoryService,
    MemoryCoreWriteTool,
    MemoryAddTool,
    MemorySearchTool,
    MemoryDeleteTool,
    McpService,
    PromptService,
    ModelResolver,
    ModelRunContext,
    AccountGraphProvider,
    ContextBuilder,
    ThreadStateService,
    GraphRunner,
  ],
  exports: [
    GraphRunner,
    ModelResolver,
    ModelRunContext,
    ThreadStateService,
    PromptService,
    ToolRegistry,
    SkillService,
    McpService,
    MeshbotConfigModule,
  ],
})
export class AgentModule {}
