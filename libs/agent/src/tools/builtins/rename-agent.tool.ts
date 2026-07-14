import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { AgentContextService } from "../../account/agent-context.service";
import { AGENT_RENAME_PORT, type AgentRenamePort } from "../agent-rename.port";
import { Tool } from "../tool.decorator";
import type { MeshbotTool } from "../tool.types";

const RenameAgentArgsSchema = z.object({
  name: z.string().min(1).max(32),
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
