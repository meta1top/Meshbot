import { randomUUID } from "node:crypto";
import { AccountContextService } from "@meshbot/lib-agent";
import type { AgentRunEnd, AgentRunFrame } from "@meshbot/types";
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import {
  IM_RELAY_EVENTS,
  type ImRelayAgentRunRequestEvent,
} from "../cloud/im-relay.events";
import { AgentService } from "./agent.service";
import { RemoteRunRegistryService } from "./remote-run-registry.service";
import { RunnerService } from "./runner.service";
import { SessionFrameForwarder } from "./session-frame-forwarder";
import { SessionService } from "./session.service";

/**
 * L3 B 侧：收到云端转发的远程 run 触发请求，在发起方账号的 `account.run`
 * scope 内创建/续写本地会话，`RunnerService.kick` 复用本地全套 run 逻辑
 * （零改 runner），再经 {@link SessionFrameForwarder} 订阅该 sessionId 的
 * `SESSION_WS_EVENTS.*` 打包成 `AgentRunFrame` 回发给发起设备（A）。
 *
 * 转发内核（allowedSessions 动态过滤集合 / seq 递增 / tool_call_end 剥
 * content / 子会话终止不掐断主流 / 终止事件退订）已抽到 `SessionFrameForwarder`
 * 复用（见该类注释），本服务只负责 relay 出口 payload 组装与生命周期编排。
 *
 * relay 传输层保持纯净：本服务经 EventEmitter2 `@OnEvent` 桥接（镜像
 * L2c `RemoteQueryInboundService`），不让 `ImRelayClientService` 反向依赖。
 *
 * 建订阅时向 `RemoteRunRegistryService` 登记 streamId→sessionId（M3 校验真源，
 * 供 `RemoteRunControlService` 校验 control 帧的 sessionId 归属），退订时一并
 * 移除登记，避免长连接下映射泄漏。
 */
@Injectable()
export class RemoteRunInboundService {
  private readonly logger = new Logger(RemoteRunInboundService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly runner: RunnerService,
    private readonly relay: ImRelayClientService,
    private readonly account: AccountContextService,
    private readonly emitter: EventEmitter2,
    private readonly registry: RemoteRunRegistryService,
    private readonly agents: AgentService,
  ) {}

  /**
   * relay 收到云端转发的 agent.run.start（B 侧入站）时触发。
   *
   * 【B 侧二次门控——安全命门】`forwarded.localAgentId` 是网关按可信的 CloudAgent
   * 表把云端 `targetAgentId` 解出的目标设备本地 Agent id；但**绝不信云端**——
   * 云端登记的 Agent「是否允许远程调度」状态可能过期（例如设备离线期间用户在本地
   * 关闭了某 Agent 的远程开关，云端尚未来得及对账），且转发帧里另有一份客户端
   * 提交、未经校验的 `targetAgentId`（T5 审查已确认可被同 streamId 的合法
   * requester 篡改），本方法**只使用 `localAgentId`**、绝不读取 `targetAgentId`
   * 做寻址或鉴权。本地 `agents` 表的 `remote_enabled` 才是唯一真相：查到的 Agent
   * 必须存在且 `remoteEnabled === true` 才允许落会话触发远程 run，否则一律拒绝
   * 并回 `agentRunEnd{reason:"agent_not_remotable"}`（不建会话、不 kick）——该
   * reason 只表示「Agent 不存在或未开远程」这一件事，会话归属不符是另一条
   * `session_agent_mismatch`（见下）。
   *
   * 【append 模式二次门控——真正执行的 agent 是 session.agentId，不是 localAgentId】
   * create 模式新会话的 `agentId` 就是 `localAgentId`，查它的 `remoteEnabled`
   * 天然对——但 append 模式追加进的是**已存在会话**，`RunnerService` 按
   * `session.agentId` 解析执行身份（见 `runner.service.ts` `consumeRunStream`），
   * 从不重查 `remoteEnabled`。若只校验 `localAgentId`，攻击者可拿账号里任意一个
   * `remote_enabled=true` 的「跳板」Agent X 当 localAgentId，配合任意 sessionId
   * 越权唤醒该会话真正归属、且已被用户关闭远程开关的 Agent Y——门禁形同虚设。
   * 因此 append 分支必须额外查出该 sessionId 归属的会话，并要求
   * `session.agentId === agent.id`（被追加会话必须归属被寻址的这个 Agent）：
   * 由于 `agent` 已在上面校验过 `remoteEnabled === true`，相等即隐含「真正执行
   * 的 agent 也是 remoteEnabled」，无需为 `session.agentId` 再查一次 Agent 表；
   * 且比「只查 session.agentId 的 remoteEnabled、不比对身份」更严格——后者会
   * 放行「用 remote_enabled 的 X 越权 append 进另一个同样 remote_enabled 的 Y
   * 的会话」这种未寻址却被接受的串门，相等校验把这条路也堵死。会话查无（含
   * append 一个不存在的 sessionId）同样归入拒绝路径，不放行也不崩。这条路径回
   * 的是 `reason:"session_agent_mismatch"`（**不是** `agent_not_remotable`）：
   * 此处 Agent 已确认可远程，拒绝的是「会话不归它」，前端据此给准确文案。
   */
  @OnEvent(IM_RELAY_EVENTS.agentRunRequest)
  async onAgentRunRequest(evt: ImRelayAgentRunRequestEvent): Promise<void> {
    const { cloudUserId, forwarded } = evt;
    const { streamId, requesterDeviceId, mode, content, localAgentId } =
      forwarded;
    try {
      await this.account.run(cloudUserId, async () => {
        const agent = await this.agents.findOrNull(localAgentId);
        if (!agent?.remoteEnabled) {
          this.relay.emitAgentRunEnd(cloudUserId, {
            streamId,
            requesterDeviceId,
            reason: "agent_not_remotable",
          });
          return;
        }
        if (mode === "append" && forwarded.sessionId) {
          const owner = await this.sessions.findOrNull(forwarded.sessionId);
          if (!owner || owner.agentId !== agent.id) {
            // 独立 reason：Agent 本身可远程，只是这个会话不归它（或查无）。
            // 复用 agent_not_remotable 会让前端说成「该 Agent 未开启远程访问」，
            // 与真实原因完全不符。
            this.relay.emitAgentRunEnd(cloudUserId, {
              streamId,
              requesterDeviceId,
              reason: "session_agent_mismatch",
            });
            return;
          }
        }
        const sessionId =
          mode === "create"
            ? (
                await this.sessions.createSession({
                  content,
                  agentId: agent.id,
                })
              ).sessionId
            : await this.appendToExisting(forwarded.sessionId, content);
        this.subscribeAndForward(
          cloudUserId,
          streamId,
          requesterDeviceId,
          sessionId,
        );
        this.runner.kick(sessionId);
      });
    } catch (err) {
      this.logger.warn(
        `远程 run 触发失败（streamId=${streamId}）`,
        err instanceof Error ? err.stack : err,
      );
      this.relay.emitAgentRunEnd(cloudUserId, {
        streamId,
        requesterDeviceId,
        reason: "error",
      });
    }
  }

  /** append 模式：向已存在会话追加一条消息，messageId 由本地生成（远程触发无前端可代生成）。 */
  private async appendToExisting(
    sessionId: string | undefined,
    content: string,
  ): Promise<string> {
    if (!sessionId) {
      throw new Error("append 模式缺少 sessionId");
    }
    await this.sessions.appendMessage(sessionId, {
      messageId: randomUUID(),
      content,
    });
    return sessionId;
  }

  /**
   * 订阅主 sessionId 的 `SESSION_WS_EVENTS.*` 全集，经 {@link SessionFrameForwarder}
   * 打包成 `AgentRunFrame` 经 relay 回发给发起设备（A）。转发内核（allowedSessions
   * 动态集合 / seq / tool_call_end 剥 content / 子会话终止不掐断主流）已抽到
   * `SessionFrameForwarder`，本方法只负责 relay 出口与注册表登记。
   *
   * `stopOnTerminal=true`：远程 run 是**一次性**的，主会话终止即回 `agentRunEnd`
   * 并自动退订（与 Agent 级观察通道的常驻转发器相反，后者跨多轮存活）。
   */
  private subscribeAndForward(
    cloudUserId: string,
    streamId: string,
    requesterDeviceId: string,
    sessionId: string,
  ): void {
    const forwarder = new SessionFrameForwarder(
      this.emitter,
      sessionId,
      {
        onFrame: (f) =>
          this.relay.emitAgentRunFrame(cloudUserId, {
            streamId,
            requesterDeviceId,
            seq: f.seq,
            sessionId: f.sessionId,
            event: f.event,
            payload: f.payload,
          } satisfies AgentRunFrame),
        onTerminal: (reason) => {
          this.relay.emitAgentRunEnd(cloudUserId, {
            streamId,
            requesterDeviceId,
            reason,
          } satisfies AgentRunEnd);
          this.registry.unbind(streamId);
        },
      },
      true,
    );
    forwarder.start();
    this.registry.bind(streamId, sessionId);
  }
}
