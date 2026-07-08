import { AccountContextService } from "@meshbot/lib-agent";
import type { ImSendPort } from "@meshbot/lib-agent";
import { Injectable } from "@nestjs/common";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import { ConfirmationService } from "./confirmation.service";

/** 确认超时（无人点击则 fail-safe 不发）。 */
export const IM_SEND_CONFIRM_TIMEOUT_MS = 120_000;

/**
 * IM_SEND_PORT 实现：弹卡等待用户确认（ConfirmationService），确认后经既有
 * ImRelayClientService.send 真正发出。返回 {status} JSON 给 agent。
 */
@Injectable()
export class ImSendService implements ImSendPort {
  constructor(
    private readonly confirmation: ConfirmationService,
    private readonly relay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {}

  /** 请求确认并发送；超时/中断默认不发。 */
  async confirmAndSend(
    params: {
      sessionId: string;
      toolCallId: string;
      conversationId: string;
      content: string;
    },
    signal: AbortSignal,
  ): Promise<string> {
    const cloudUserId = this.account.getOrThrow();
    const key = ConfirmationService.key(
      cloudUserId,
      params.sessionId,
      params.toolCallId,
    );
    const outcome = await this.confirmation.waitForDecision(
      key,
      signal,
      IM_SEND_CONFIRM_TIMEOUT_MS,
    );
    if (outcome === "timeout") {
      return JSON.stringify({ status: "timeout" });
    }
    if (outcome === "aborted") {
      return JSON.stringify({ status: "interrupted" });
    }
    if (outcome.action === "cancel") {
      return JSON.stringify({ status: "cancelled" });
    }
    const finalContent = outcome.content?.trim()
      ? outcome.content
      : params.content;
    try {
      this.relay.send(cloudUserId, {
        conversationId: params.conversationId,
        content: finalContent,
      });
      return JSON.stringify({ status: "sent", content: finalContent });
    } catch {
      return JSON.stringify({ status: "error" });
    }
  }
}
