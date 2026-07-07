import { AccountContextService } from "@meshbot/agent";
import type { DeviceQueryResponse } from "@meshbot/types";
import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import {
  IM_RELAY_EVENTS,
  type ImRelayDeviceQueryRequestEvent,
} from "../cloud/im-relay.events";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";

/**
 * L2c B 侧：收到云端转发的跨设备查询请求，在发起方账号的 `account.run` scope
 * 内查本地会话数据，再经 {@link ImRelayClientService.emitDeviceQueryResponse}
 * 回发响应（best-effort，relay 未连接时静默丢弃——A 侧已有超时兜底）。
 *
 * 查询抛错（如 sessionId 不存在）→ 回 `ok:false, reason:"error"`，不让异常
 * 冒泡出 EventEmitter2 的事件处理器（否则会打进程未捕获异常日志）。
 */
@Injectable()
export class RemoteQueryInboundService {
  constructor(
    private readonly sessions: SessionService,
    private readonly messages: SessionMessageService,
    private readonly relay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {}

  /** relay 收到 device.query.request（云端转发）时触发；按 kind 查本地会话数据。 */
  @OnEvent(IM_RELAY_EVENTS.deviceQueryRequest)
  async onDeviceQueryRequest(
    evt: ImRelayDeviceQueryRequestEvent,
  ): Promise<void> {
    const { cloudUserId, forwarded } = evt;
    const base = {
      correlationId: forwarded.correlationId,
      requesterDeviceId: forwarded.requesterDeviceId,
    };
    try {
      await this.account.run(cloudUserId, async () => {
        const data =
          forwarded.kind === "sessions"
            ? await this.sessions.listAllSorted()
            : await this.messages.listPage(forwarded.params.sessionId ?? "", {
                before: forwarded.params.before,
                limit: Math.min(Math.max(1, forwarded.params.limit ?? 50), 100),
              });
        this.relay.emitDeviceQueryResponse(cloudUserId, {
          ...base,
          ok: true,
          data,
        } satisfies DeviceQueryResponse);
      });
    } catch {
      this.relay.emitDeviceQueryResponse(cloudUserId, {
        ...base,
        ok: false,
        reason: "error",
      });
    }
  }
}
