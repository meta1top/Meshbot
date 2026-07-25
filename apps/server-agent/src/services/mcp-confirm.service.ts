import { AccountContextService } from "@meshbot/lib-agent";
import type { McpConfirmPort, McpServerConfig } from "@meshbot/lib-agent";
import { Injectable } from "@nestjs/common";
import { ConfirmationService } from "./confirmation.service";

/** 确认超时（无人点击则 fail-safe 不安装）。 */
export const MCP_INSTALL_CONFIRM_TIMEOUT_MS = 120_000;

/**
 * MCP_CONFIRM_PORT 实现：弹卡等待用户确认（挂现有 ConfirmationService 单例），
 * 决定值映射为端口的四态返回。决定值语义沿用 `im_send` 的 "send"|"cancel"
 * （前端确认卡走既有 confirm 通道，无需新 REST/WS）。本服务只负责「问、等、
 * 翻译决定」——落盘由 `mcp_install` 工具自己在确认后调
 * `McpService.updateConfig`，本服务不碰配置文件。
 */
@Injectable()
export class McpConfirmService implements McpConfirmPort {
  constructor(
    private readonly confirmation: ConfirmationService,
    private readonly account: AccountContextService,
  ) {}

  /** 挂起等用户确认；超时/中断 fail-safe（视为不安装）。 */
  async confirmInstall(
    params: {
      sessionId: string;
      toolCallId: string;
      name: string;
      server: McpServerConfig;
    },
    signal: AbortSignal,
  ): Promise<"confirmed" | "cancelled" | "timeout" | "interrupted"> {
    const cloudUserId = this.account.getOrThrow();
    const key = ConfirmationService.key(
      cloudUserId,
      params.sessionId,
      params.toolCallId,
    );
    const outcome = await this.confirmation.waitForDecision(
      key,
      signal,
      MCP_INSTALL_CONFIRM_TIMEOUT_MS,
    );
    if (outcome === "timeout") {
      return "timeout";
    }
    if (outcome === "aborted") {
      return "interrupted";
    }
    return outcome.action === "cancel" ? "cancelled" : "confirmed";
  }
}
