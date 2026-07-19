import { AccountContextService } from "@meshbot/lib-agent";
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
 * **Agent 级观察通道 D2/D3（Task 16）**：`forwarded` 支持双寻址——
 * `streamId`（发起方，既有语义）或 `watchId`（观察者应答 HITL）二选一。
 * `interrupt` 不接受 watchId 寻址（打断权限限发起方，二次门控，协议层 zod
 * 已拒）；`confirm`/`answer` 走对应的 `sessionIdOf`/`sessionIdOfWatch` 绑定
 * 校验后 resolve。`ConfirmationService.resolve` 已返回 boolean，天然实现
 * **先到先得**（D3）：同一 toolCallId 只有首个到达的应答能 resolve 成功，
 * 其余静默忽略（晚到方的告知走 Task 17 的关卡广播帧）。
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
          if (forwarded.watchId) {
            // 打断权限限发起方（spec「不在本轮」）：观察者只能应答 HITL。
            // 协议层 zod 已拒，这里是二次门控——relay 转发的是已解析对象，
            // 不能假设它一定过了 schema。
            this.logger.warn(
              `观察者尝试中断（watchId=${forwarded.watchId}），拒`,
            );
            return;
          }
          this.runner.interrupt(forwarded.sessionId);
          return;
        }
        if (!forwarded.toolCallId) {
          this.logger.warn(
            `远程 ${forwarded.kind} 缺 toolCallId（sessionId=${forwarded.sessionId}），忽略`,
          );
          return;
        }

        // 双寻址的绑定校验：streamId 走 streamToSession，watchId 走
        // watchToSession。两者语义一致——「这条控制帧声称要操作的
        // sessionId，确实是该 id 名下登记的那个会话」，防同账号内跨会话
        // resolve（观察者场景下同时防跨通道越权 resolve）。
        const bound = forwarded.watchId
          ? this.registry.sessionIdOfWatch(forwarded.watchId)
          : this.registry.sessionIdOf(forwarded.streamId as string);
        if (bound !== forwarded.sessionId) {
          this.logger.warn(
            `远程 ${forwarded.kind} sessionId 与 ${forwarded.watchId ? "watchId" : "streamId"} 绑定不符，拒`,
          );
          return;
        }
        const key = ConfirmationService.key(
          cloudUserId,
          forwarded.sessionId,
          forwarded.toolCallId,
        );
        // 双寻址即身份：watchId 寻址 = 观察者应答，streamId 寻址 = 发起方
        // 应答——与上面 :77-79 的绑定校验分支同一个判据，直接复用。
        const by: "remote" | "observer" = forwarded.watchId
          ? "observer"
          : "remote";
        const meta = {
          sessionId: forwarded.sessionId,
          toolCallId: forwarded.toolCallId,
          by,
        };
        // 显式收窄成 === "answer"，不能用「非 confirm 即 answer」的三元——
        // relay 转发的是已解析对象，不能假设它一定过了 schema（同 :56-57 的
        // 二次门控理由，且经核实网关的 zod 校验实际未生效）。一条 kind
        // 缺失/拼错但 toolCallId 合法、绑定校验也通过的转发帧，若被当成
        // answer 处理，会拿 `{answers: []}` 去 resolve 一个挂起的
        // ask_question——这正是改动前 `else if` 版本本就防住的情形。
        let ok: boolean;
        if (forwarded.kind === "confirm") {
          ok = this.confirmation.resolve(
            key,
            {
              action: forwarded.decision ?? "cancel",
              content: forwarded.content,
            },
            meta,
          );
        } else if (forwarded.kind === "answer") {
          ok = this.confirmation.resolve(
            key,
            { answers: forwarded.answers ?? [] },
            meta,
          );
        } else {
          this.logger.warn(
            `远程控制帧 kind 非法（kind=${String(forwarded.kind)}，toolCallId=${forwarded.toolCallId}），拒`,
          );
          return;
        }
        // 先到先得（D3）：ConfirmationService 是单例挂起核心，天然只 resolve
        // 一次——首个到达的应答返 true 并关卡，其余返 false。晚到方靠 Task 17
        // 的关卡广播帧把卡片置为已完成（不是弹错误框）。
        if (!ok) {
          this.logger.debug(
            `HITL 已由其它端应答（toolCallId=${forwarded.toolCallId}），本次忽略`,
          );
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
