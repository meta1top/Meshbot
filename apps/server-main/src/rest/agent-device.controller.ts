import { AppError, CommonErrorCode } from "@meshbot/common";
import { ConversationService } from "@meshbot/main";
import { Controller, Get } from "@nestjs/common";

import { CurrentUser } from "../auth/current-user.decorator";
import type { JwtMainPayload } from "../auth/jwt.strategy";

/**
 * Agent 设备侧 REST 端点 —— device token 认证（`JwtAuthGuard` 双凭据分支，`@CurrentUser().deviceId` 非空）。
 *
 * main.ts 已 setGlobalPrefix("api")，故此处 @Controller("agent") 挂载后实际路由为：
 * - GET /api/agent/conversations   列出本设备参与的全部 Agent-DM 会话（跨组织枚举，供设备侧补处理用）
 *
 * Controller 只做路由接入 + 编排，业务逻辑委派给 ConversationService。
 */
@Controller("agent")
export class AgentDeviceController {
  constructor(private readonly conversation: ConversationService) {}

  /**
   * 列出本设备（device token 身份）参与的全部 Agent-DM 会话。
   * 缺 deviceId（如误用浏览器用户 JWT 调用）一律抛 FORBIDDEN，防止越权枚举。
   */
  @Get("conversations")
  async listConversations(
    @CurrentUser() user: JwtMainPayload,
  ): Promise<{ conversationId: string; orgId: string }[]> {
    if (!user.deviceId) throw new AppError(CommonErrorCode.FORBIDDEN);
    return this.conversation.listAgentDmsForDevice(user.deviceId);
  }
}
