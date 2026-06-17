import { Body, Controller, Get, Param, Put } from "@nestjs/common";

import { SetAgentEnabledDto } from "../dto/im-agent.dto";
import { CloudImService } from "../services/cloud-im.service";
import { SessionService } from "../services/session.service";

/** IM 伴生 Agent 会话的本地 REST：取伴生会话 + 开关切换。 */
@Controller("api/im")
export class ImAgentController {
  constructor(
    private readonly sessions: SessionService,
    private readonly cloudIm: CloudImService,
  ) {}

  /** 从云端会话列表解析某会话的类型与标题（建伴生会话用）。 */
  private async resolveConv(
    conversationId: string,
  ): Promise<{ type: "channel" | "dm"; title: string }> {
    const convs = await this.cloudIm.listConversations();
    const conv = convs.find((c) => c.id === conversationId);
    const type: "channel" | "dm" = conv?.type === "channel" ? "channel" : "dm";
    const title = conv?.name ?? conv?.peer?.displayName ?? "IM 会话";
    return { type, title };
  }

  /** 取（或惰性建）某 IM 会话的伴生会话 id + 开关状态。 */
  @Get(":conversationId/agent-session")
  async getAgentSession(
    @Param("conversationId") conversationId: string,
  ): Promise<{
    sessionId: string;
    agentEnabled: boolean;
    convType: "channel" | "dm";
  }> {
    const { type, title } = await this.resolveConv(conversationId);
    const companion = await this.sessions.findOrCreateImCompanion(
      conversationId,
      type,
      title,
    );
    return {
      sessionId: companion.id,
      agentEnabled: companion.agentEnabled,
      convType: (companion.imConvType ?? type) as "channel" | "dm",
    };
  }

  /** 切换某 IM 会话伴生 Agent 开关。 */
  @Put(":conversationId/agent-session")
  async setAgentEnabled(
    @Param("conversationId") conversationId: string,
    @Body() dto: SetAgentEnabledDto,
  ): Promise<{ ok: true }> {
    const { type, title } = await this.resolveConv(conversationId);
    await this.sessions.findOrCreateImCompanion(conversationId, type, title);
    await this.sessions.setCompanionAgentEnabled(conversationId, dto.enabled);
    return { ok: true };
  }
}
