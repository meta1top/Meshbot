import { AccountContextService } from "@meshbot/agent";
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  IM_RELAY_EVENTS,
  type ImRelayAgentRunControlEvent,
} from "../cloud/im-relay.events";
import { ConfirmationService } from "./confirmation.service";
import { RemoteRunRegistryService } from "./remote-run-registry.service";
import { RunnerService } from "./runner.service";

/**
 * L3 B 侧：收到云端转发的远程运行控制指令（interrupt/confirm/answer），在
 * 发起方账号的 `account.run` scope 内驱动本地 `RunnerService` /
 * `ConfirmationService`。
 *
 * `interrupt` 复用 {@link RunnerService.interrupt}（零改 runner；中断后触发
 * 的 `run.interrupted` 会经 `RemoteRunInboundService` 已订阅的
 * `SESSION_WS_EVENTS.*` 正常回帧给 A，无需本服务额外回发）。`confirm`/
 * `answer` 经 {@link ConfirmationService.resolve} 解锁本地挂起的工具确认 /
 * 追问，解锁前经 `RemoteRunRegistryService`（M3）校验该 streamId 确对应
 * control 帧携带的 sessionId，防同账号内跨会话 resolve。
 *
 * relay 传输层保持纯净：本服务经 EventEmitter2 `@OnEvent` 桥接（镜像
 * `RemoteRunInboundService`/`RemoteQueryInboundService`），不让
 * `ImRelayClientService` 反向依赖。
 */
@Injectable()
export class RemoteRunControlService {
  private readonly logger = new Logger(RemoteRunControlService.name);

  constructor(
    private readonly runner: RunnerService,
    private readonly account: AccountContextService,
    private readonly confirmation: ConfirmationService,
    private readonly registry: RemoteRunRegistryService,
  ) {}

  /** relay 收到云端转发的 agent.run.control（B 侧入站）时触发。 */
  @OnEvent(IM_RELAY_EVENTS.agentRunControlInbound)
  onAgentRunControl(evt: ImRelayAgentRunControlEvent): void {
    const { cloudUserId, forwarded } = evt;
    try {
      this.account.run(cloudUserId, () => {
        if (forwarded.kind === "interrupt") {
          this.runner.interrupt(forwarded.sessionId);
          return;
        }
        if (!forwarded.toolCallId) {
          this.logger.warn(
            `远程 ${forwarded.kind} 缺 toolCallId（sessionId=${forwarded.sessionId}），忽略`,
          );
          return;
        }

        const bound = this.registry.sessionIdOf(forwarded.streamId);
        if (bound !== forwarded.sessionId) {
          this.logger.warn(
            `远程 ${forwarded.kind} sessionId 与 streamId 绑定不符（streamId=${forwarded.streamId}），拒`,
          );
          return;
        }
        const key = ConfirmationService.key(
          cloudUserId,
          forwarded.sessionId,
          forwarded.toolCallId,
        );
        if (forwarded.kind === "confirm") {
          this.confirmation.resolve(key, {
            action: forwarded.decision ?? "cancel",
            content: forwarded.content,
          });
        } else if (forwarded.kind === "answer") {
          this.confirmation.resolve(key, { answers: forwarded.answers ?? [] });
        }
      });
    } catch (err) {
      this.logger.warn(
        `远程运行控制处理失败（sessionId=${forwarded.sessionId}, kind=${forwarded.kind}）`,
        err instanceof Error ? err.stack : err,
      );
    }
  }
}
