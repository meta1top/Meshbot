import {
  QUICK_ASSISTANT_EVENTS,
  type QuickAssistantName,
  type QuickAssistantRenamedEvent,
} from "@meshbot/types-agent";
import { Body, Controller, Get, Patch } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { RenameQuickAssistantDto } from "../dto/quick-assistant.dto";
import { AgentService } from "../services/agent.service";

/**
 * 随手问命名 REST。名字不再独立存储（Task 8 前是账号级 Setting），
 * 统一读写账号默认 Agent（`AgentService.ensureDefault()`）的 `name`——
 * 与 `rename_agent` 工具改的是同一份数据，不会出现「工具改了 UI 没变」。
 * 瘦 Controller —— 逻辑委托给 AgentService，仅多一步 ws 事件通知。
 */
@Controller("api/quick-assistant")
export class QuickAssistantController {
  constructor(
    private readonly agents: AgentService,
    private readonly emitter: EventEmitter2,
  ) {}

  /** 取随手问当前名字（即账号默认 Agent 的 name）。 */
  @Get("name")
  async getName(): Promise<QuickAssistantName> {
    const agent = await this.agents.ensureDefault();
    return { name: agent.name };
  }

  /**
   * 改随手问名字：写默认 Agent 的 name + ws 实时推送，多窗口/agent 改名一致刷新。
   * 注意：`rename_agent` 工具改名走 AGENT_RENAME_PORT（不经过此 Controller），
   * 但当改名目标是默认 Agent 时，该端口的实现（runtime-context.module.ts 的
   * `createAgentRenamePort`）也会 emit 同一个 ws 事件，两条路径对齐。
   */
  @Patch("name")
  async rename(
    @Body() dto: RenameQuickAssistantDto,
  ): Promise<QuickAssistantName> {
    const agent = await this.agents.ensureDefault();
    await this.agents.update(agent.id, { name: dto.name });
    this.emitter.emit(QUICK_ASSISTANT_EVENTS.renamed, {
      name: dto.name,
    } satisfies QuickAssistantRenamedEvent);
    return { name: dto.name };
  }
}
