import { randomUUID } from "node:crypto";
import { AccountContextService } from "@meshbot/lib-agent";
import type { AgentRunEnd, AgentRunFrame } from "@meshbot/types";
import {
  SESSION_WS_EVENTS,
  type RunSubagentSettledEvent,
  type RunSubagentSpawnedEvent,
  type RunToolCallEndEvent,
} from "@meshbot/types-agent";
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
import { SessionService } from "./session.service";

/**
 * 需要转发给 A 侧的 `SESSION_WS_EVENTS.*` 全集（`session.subscribe` /
 * `unsubscribe` / `interrupt` 是客户端上行 socket 消息、`runSnapshot` 只在
 * 订阅时点对点补发，均不经 EventEmitter2 广播，转发这些名字永远收不到事件，
 * 故排除；其余 18 个由 RunnerService / ContextCompactor / DispatchSubagentService /
 * SessionTitleService 经 EventEmitter2 广播，逐个转发）。
 */
const FORWARDED_SESSION_EVENTS: readonly string[] = [
  SESSION_WS_EVENTS.runHuman,
  SESSION_WS_EVENTS.runReasoning,
  SESSION_WS_EVENTS.runReasoningDone,
  SESSION_WS_EVENTS.runChunk,
  SESSION_WS_EVENTS.runDone,
  SESSION_WS_EVENTS.runInterrupted,
  SESSION_WS_EVENTS.runError,
  SESSION_WS_EVENTS.runUsage,
  SESSION_WS_EVENTS.runToolCallStart,
  SESSION_WS_EVENTS.runToolCallProgress,
  SESSION_WS_EVENTS.runToolCallArgsDelta,
  SESSION_WS_EVENTS.runToolCallEnd,
  SESSION_WS_EVENTS.runCompactionStart,
  SESSION_WS_EVENTS.runCompactionDone,
  SESSION_WS_EVENTS.runCompactionError,
  SESSION_WS_EVENTS.runSubagentSpawned,
  SESSION_WS_EVENTS.runSubagentSettled,
  SESSION_WS_EVENTS.titleUpdated,
];

/** 终止事件 → `AgentRunEnd.reason` 映射；收到即回 agentRunEnd + 退订全部监听器。 */
const TERMINAL_REASON_BY_EVENT: ReadonlyMap<string, AgentRunEnd["reason"]> =
  new Map([
    [SESSION_WS_EVENTS.runDone, "done"],
    [SESSION_WS_EVENTS.runError, "error"],
    [SESSION_WS_EVENTS.runInterrupted, "interrupted"],
  ]);

/**
 * run.tool_call_end 转发前剥掉 `content` 字段（可能很大，如长文件读取结果）。
 * 与 `session.gateway.ts` 对 A 本地前端的处理保持一致——前端只用
 * `resultPreview` 渲染，`content` 没必要经 relay 跨设备中继一份，白白浪费
 * 带宽/体积。
 */
function stripToolCallEndContent(
  payload: RunToolCallEndEvent,
): Omit<RunToolCallEndEvent, "content"> {
  const { content: _content, ...rest } = payload;
  return rest;
}

/**
 * L3 B 侧：收到云端转发的远程 run 触发请求，在发起方账号的 `account.run`
 * scope 内创建/续写本地会话，`RunnerService.kick` 复用本地全套 run 逻辑
 * （零改 runner），再订阅该 sessionId 的 `SESSION_WS_EVENTS.*` 打包成
 * `AgentRunFrame` 经 relay 回发给发起设备（A）。
 *
 * 按动态 sessionId 集合精确过滤：B 上可能有多个会话/多个远程 run 并行，
 * 同一事件名会被多个请求各自的监听器收到，只有 `payload.sessionId` 命中
 * 本次登记的集合（初始只含主会话 sessionId）才转发，防止跨 run 串台。
 *
 * 子代理过程流：收到 `runSubagentSpawned`（主会话事件，携带
 * `subSessionId`）→ 把子会话 id 并入过滤集合，子会话的 runChunk 等过程
 * 事件才能进帧；收到 `runSubagentSettled` → 把该子会话 id 移出集合。
 *
 * 终止事件（run.done/run.error/run.interrupted）只认主会话：必须
 * `payload.sessionId === sessionId` 才触发 `agentRunEnd` + 退订，子会话的
 * 终止事件（子代理跑完）不得掐断主流——否则子代理一结束整个远程流就断。
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
   * 并回 `agentRunEnd{reason:"agent_not_remotable"}`（不建会话、不 kick）。
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
   * append 一个不存在的 sessionId）同样归入拒绝路径，不放行也不崩。
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
            this.relay.emitAgentRunEnd(cloudUserId, {
              streamId,
              requesterDeviceId,
              reason: "agent_not_remotable",
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
   * 订阅主 sessionId 的 `SESSION_WS_EVENTS.*` 全集，按动态过滤集合
   * `allowedSessions` 过滤后打包成 `AgentRunFrame` 经 relay 回发；集合初始只
   * 含主 sessionId，收到 `runSubagentSpawned` 时并入其 `subSessionId`（子代理
   * 过程流才能进帧），收到 `runSubagentSettled` 时移出。命中终止事件且
   * `payload.sessionId` 是主 sessionId 本身时才额外回发 `agentRunEnd` 并退订
   * 本次登记的全部监听器（子会话终止不掐断主流）。监听器就绪后向
   * `RemoteRunRegistryService` 登记 streamId→主 sessionId，退订时一并解除。
   */
  private subscribeAndForward(
    cloudUserId: string,
    streamId: string,
    requesterDeviceId: string,
    sessionId: string,
  ): void {
    let seq = 0;
    const allowedSessions = new Set<string>([sessionId]);
    const registered: Array<{
      event: string;
      handler: (payload: unknown) => void;
    }> = [];

    const unsubscribeAll = (): void => {
      for (const { event, handler } of registered) {
        this.emitter.off(event, handler);
      }
      this.registry.unbind(streamId);
    };

    for (const event of FORWARDED_SESSION_EVENTS) {
      const handler = (payload: unknown): void => {
        const payloadSessionId = (payload as { sessionId?: unknown })
          ?.sessionId;
        if (
          typeof payloadSessionId !== "string" ||
          !allowedSessions.has(payloadSessionId)
        ) {
          return; // 不在当前登记集合内的 session——防串台
        }

        if (event === SESSION_WS_EVENTS.runSubagentSpawned) {
          allowedSessions.add(
            (payload as RunSubagentSpawnedEvent).subSessionId,
          );
        } else if (event === SESSION_WS_EVENTS.runSubagentSettled) {
          allowedSessions.delete(
            (payload as RunSubagentSettledEvent).subSessionId,
          );
        }

        seq += 1;
        // run.tool_call_end 转发前剥掉 content（可能很大，如长文件读取结果）：
        // 照 session.gateway.ts 对 A 本地前端的处理——前端只用 resultPreview，
        // content 没必要经 relay 跨设备中继，白白浪费带宽/体积。
        const wirePayload =
          event === SESSION_WS_EVENTS.runToolCallEnd
            ? stripToolCallEndContent(payload as RunToolCallEndEvent)
            : payload;
        this.relay.emitAgentRunFrame(cloudUserId, {
          streamId,
          requesterDeviceId,
          seq,
          sessionId: payloadSessionId,
          event,
          payload: wirePayload,
        } satisfies AgentRunFrame);

        const reason = TERMINAL_REASON_BY_EVENT.get(event);
        if (reason && payloadSessionId === sessionId) {
          this.relay.emitAgentRunEnd(cloudUserId, {
            streamId,
            requesterDeviceId,
            reason,
          } satisfies AgentRunEnd);
          unsubscribeAll();
        }
      };
      this.emitter.on(event, handler);
      registered.push({ event, handler });
    }

    this.registry.bind(streamId, sessionId);
  }
}
