import { QUICK_ASSISTANT_NAME_MAX } from "@meshbot/types-agent";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { AgentContextService } from "../../account/agent-context.service";
import { AGENT_RENAME_PORT, type AgentRenamePort } from "../agent-rename.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool } from "../tool.types";

// 长度上限复用 REST 侧同一个常量（QUICK_ASSISTANT_NAME_MAX），避免工具改名与
// 面板手动改名对同一个 agents.name 字段出现两套上限；trim() 防纯空格名。
const RenameAgentArgsSchema = z.object({
  name: z.string().trim().min(1).max(QUICK_ASSISTANT_NAME_MAX),
});
type RenameAgentArgs = z.infer<typeof RenameAgentArgsSchema>;

/**
 * rename_agent —— 给当前 Agent 改名（取代旧的 rename_quick_assistant）。
 *
 * 当前 Agent 由 AgentContextService（AsyncLocalStorage）在 run 期间自动挂载，
 * 无需调用方显式传 agentId。写库经 AGENT_RENAME_PORT 转交 server-agent 的
 * AgentService（libs/agent 不能反向依赖 server-agent）。
 */
@Injectable()
@Tool()
export class RenameAgentTool implements MeshbotTool<RenameAgentArgs, string> {
  readonly name = "rename_agent";
  readonly description =
    "Rename yourself — set your own display name. " +
    "Use ONLY when the user explicitly asks to change your name " +
    "(e.g. “改名叫 X” / “call you X”). Takes the new name; persists it. " +
    "Returns confirmation of the new name. " +
    "This is a rename action only — it does not define what your name currently is.";
  readonly schema = RenameAgentArgsSchema;

  constructor(
    private readonly agentCtx: AgentContextService,
    @Inject(AGENT_RENAME_PORT) private readonly port: AgentRenamePort,
  ) {}

  /** 给当前 Agent 改名并返回确认文案。 */
  async execute(args: RenameAgentArgs): Promise<string> {
    const agentId = this.agentCtx.getOrThrow();
    await this.port.rename(agentId, args.name);
    return `已改名为「${args.name}」`;
  }
}
