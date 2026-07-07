import { AccountContextService } from "@meshbot/agent";
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import {
  IM_RELAY_EVENTS,
  type ImRelayAgentRunControlEvent,
} from "../cloud/im-relay.events";
import { RunnerService } from "./runner.service";

/**
 * L3 B 侧：收到云端转发的远程运行控制指令（interrupt/confirm/answer），在
 * 发起方账号的 `account.run` scope 内驱动本地 `RunnerService`。
 *
 * Phase A 仅实现 `interrupt`（复用 {@link RunnerService.interrupt}，零改
 * runner；中断后触发的 `run.interrupted` 会经 `RemoteRunInboundService`
 * 已订阅的 `SESSION_WS_EVENTS.*` 正常回帧给 A，无需本服务额外回发）。
 * `confirm`/`answer` 是 Phase B 范围（远程确认发送 / 远程追问作答），这里
 * 先留 no-op 占位，不在 Phase A 处理。
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
  ) {}

  /** relay 收到云端转发的 agent.run.control（B 侧入站）时触发。 */
  @OnEvent(IM_RELAY_EVENTS.agentRunControlInbound)
  onAgentRunControl(evt: ImRelayAgentRunControlEvent): void {
    const { cloudUserId, forwarded } = evt;
    try {
      this.account.run(cloudUserId, () => {
        if (forwarded.kind === "interrupt") {
          this.runner.interrupt(forwarded.sessionId);
        }
        // confirm/answer: Phase B 实现远程 confirm/answer，Phase A 暂不处理。
      });
    } catch (err) {
      this.logger.warn(
        `远程运行控制处理失败（sessionId=${forwarded.sessionId}, kind=${forwarded.kind}）`,
        err instanceof Error ? err.stack : err,
      );
    }
  }
}
