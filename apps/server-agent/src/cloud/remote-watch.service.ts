import { randomBytes } from "node:crypto";
import type {
  AgentRunFrame,
  AgentWatchAccepted,
  AgentWatchStartInput,
  WatchScope,
} from "@meshbot/types";
import {
  REMOTE_AGENT_EVENTS,
  RunSnapshotEventSchema,
  SESSION_WS_EVENTS,
  type RemoteAgentSessionEventPayload,
  type RunSnapshotEvent,
} from "@meshbot/types-agent";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import {
  REMOTE_SHADOW_FRAME_EVENT,
  type RemoteShadowFramePayload,
} from "../ws/session-shadow.events";
import { ImRelayClientService } from "./im-relay-client.service";
import { IM_RELAY_EVENTS, type ImRelayConnectedEvent } from "./im-relay.events";

/** 单条 watch 登记：所属账号 + 目标云端 Agent id + 观察粒度 + （session 级）被观察会话 id。 */
interface WatchEntry {
  cloudUserId: string;
  targetAgentId: string;
  scope: WatchScope;
  sessionId?: string;
}

/**
 * A 侧观察者代理服务（Task 18：server-agent 观察者代理层，web-agent 的 D4
 * 对称）。
 *
 * web-agent 浏览器不直连云端，必须经自己的 server-agent 代理发起/维持 Agent
 * 级观察通道（watch）。结构镜像 `RemoteRunService`：进程内 `Map<watchId,
 * WatchEntry>` 登记 + `@OnEvent` 桥接 relay 回流 + `onModuleDestroy` 清理。
 *
 * **两条分流规则（重复投递防护，spec 命门）**：
 * 1. **Session 级观察帧**（推理帧）→ 重发到既有的 `REMOTE_SHADOW_FRAME_EVENT`
 *    桥（`RemoteRunService.onFrame` 同款用法）→ `SessionGateway` 按
 *    `payload.sessionId` 转发到对应 room。web-agent 的远程会话视图本来就订阅
 *    该 sessionId 的 ws/session 房间，前端零改动即可实时。
 * 2. **Agent 级生命周期帧** → **绝不**重发成本地 `SESSION_LIFECYCLE_EVENTS.*`
 *    ——那条总线上挂着 `AgentWatchMirrorService`（会把别人的事件当自己的再
 *    镜像出去，形成回环）与 `EventsGateway` 的本地下发路径（浏览器会把远程
 *    会话误插进**本机**列表）。必须包进专属信封
 *    `REMOTE_AGENT_EVENTS.sessionEvent`，带上云端 agentId，浏览器按 agentId
 *    分流到对应的远程 Agent 视图——与 `REMOTE_SHADOW_FRAME_EVENT` 不复用原始
 *    事件名是同一个理由（见其 JSDoc）。
 *
 * 两个服务（本服务与 `RemoteRunService`）都监听同一个 relay 事件
 * `IM_RELAY_EVENTS.agentRunFrame`，各自按 `frame.watchId` / `frame.streamId`
 * 是否存在短路——本服务只处理带 `watchId` 的帧，`RemoteRunService.onFrame`
 * 首行 `if (frame.watchId) return;` 把带 watchId 的帧让给本服务（互斥，见协议
 * `AgentRunFrameSchema` 的「streamId 与 watchId 二选一必填」约束）。
 */
@Injectable()
export class RemoteWatchService implements OnModuleDestroy {
  private readonly watches = new Map<string, WatchEntry>();

  constructor(
    private readonly relay: ImRelayClientService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * 发起对目标远程 Agent 的观察：生成 watchId、登记、经 relay 上行
   * `agent.watch.start`。
   *
   * @param cloudUserId   发起账号
   * @param targetAgentId 目标云端 Agent id
   * @param scope         `agent`：订会话生命周期镜像；`session`：订推理帧
   * @param sessionId     scope="session" 时必填：被观察会话在目标设备上的 id
   */
  startWatch(
    cloudUserId: string,
    targetAgentId: string,
    scope: WatchScope,
    sessionId?: string,
  ): { watchId: string } {
    const watchId = randomBytes(16).toString("hex");
    this.watches.set(watchId, { cloudUserId, targetAgentId, scope, sessionId });
    try {
      this.relay.emitAgentWatchStart(cloudUserId, {
        watchId,
        targetAgentId,
        scope,
        sessionId,
      } satisfies AgentWatchStartInput);
    } catch (e) {
      this.watches.delete(watchId);
      throw e;
    }
    return { watchId };
  }

  /** 显式注销观察：经 relay 上行 `agent.watch.stop` 并解除本地登记。 */
  stopWatch(cloudUserId: string, watchId: string): void {
    this.relay.emitAgentWatchStop(cloudUserId, { watchId });
    this.watches.delete(watchId);
  }

  /** 该 watchId 当前是否仍登记在本服务。 */
  owns(watchId: string): boolean {
    return this.watches.has(watchId);
  }

  /**
   * relay 收到云端 fan-out 的观察帧：只处理带 `watchId` 的帧（带 `streamId`
   * 的是 `RemoteRunService` 自己发起的远程 run，交给它处理，见类注释的互斥
   * 约定）。未登记的 watchId（已 stop / 已过期）→ 忽略。
   *
   * 按登记时的 scope 分流：`session` → 影子桥（复用既有渲染）；`agent` →
   * 专属信封（防污染本地列表 + 防镜像回环，见类注释）。
   */
  @OnEvent(IM_RELAY_EVENTS.agentRunFrame)
  onFrame(frame: AgentRunFrame): void {
    if (!frame.watchId) return;
    const entry = this.watches.get(frame.watchId);
    if (!entry) return;
    if (entry.scope === "session") {
      this.emitter.emit(REMOTE_SHADOW_FRAME_EVENT, {
        event: frame.event,
        payload: frame.payload,
      } satisfies RemoteShadowFramePayload);
    } else {
      this.emitter.emit(REMOTE_AGENT_EVENTS.sessionEvent, {
        agentId: entry.targetAgentId,
        event: frame.event,
        payload: frame.payload,
      } satisfies RemoteAgentSessionEventPayload);
    }
  }

  /**
   * relay 收到云端回流的 watch 受理回包：`ok:false` → 解除登记（不留悬挂，
   * 通道从未建立成功无需再发 unwatch）；`ok:true` 且 session 级时把
   * `inflight` 合成一条 `run.snapshot` 经影子桥补发（spec D7 中途续上）。
   */
  @OnEvent(IM_RELAY_EVENTS.agentWatchAcceptedInbound)
  onAccepted(accepted: AgentWatchAccepted): void {
    if (!accepted.ok) {
      this.watches.delete(accepted.watchId);
      return;
    }
    const entry = this.watches.get(accepted.watchId);
    if (!entry || entry.scope !== "session" || !entry.sessionId) return;
    const snapshot = RemoteWatchService.inflightToSnapshotEvent(
      entry.sessionId,
      accepted.inflight,
    );
    if (snapshot) {
      this.emitter.emit(
        REMOTE_SHADOW_FRAME_EVENT,
        snapshot satisfies RemoteShadowFramePayload,
      );
    }
  }

  /**
   * relay（重）连成功 → 该账号名下全部 watch 自动重发 `agent.watch.start`
   * （D5）。只重发触发账号自己的 watch（多账号不串）。
   */
  @OnEvent(IM_RELAY_EVENTS.connected)
  onRelayConnected(event: ImRelayConnectedEvent): void {
    for (const [watchId, entry] of this.watches) {
      if (entry.cloudUserId !== event.cloudUserId) continue;
      this.relay.emitAgentWatchStart(entry.cloudUserId, {
        watchId,
        targetAgentId: entry.targetAgentId,
        scope: entry.scope,
        sessionId: entry.sessionId,
      } satisfies AgentWatchStartInput);
    }
  }

  /** 模块销毁时清空全部登记，防泄漏。 */
  onModuleDestroy(): void {
    this.watches.clear();
  }

  /**
   * 把 `watch_accepted.inflight`（设备侧 `RunnerService.getInflight` 的
   * `InflightView`）合成一条 `run.snapshot` 事件。
   *
   * 与 `packages/web-common/src/session/watch-inflight.ts` 的
   * `inflightToSnapshotEvent` **同源**（那是浏览器端消费云端直连观察帧的版
   * 本，本服务是 web-agent 经本机 server-agent 代理的版本）——server-agent
   * 不能 import web-common（依赖方向禁止 apps 互相 import），故这里就地写一份
   * 等价转换，两处形状必须保持一致，改动需同步。
   *
   * 返回 null：`inflight` 缺失/形状不对，或 `messageId` 非法（该会话当前没
   * 在跑，或本轮已落库不再是活 partial）——不是错误，静默跳过。
   */
  private static inflightToSnapshotEvent(
    sessionId: string,
    inflight: unknown,
  ): { event: string; payload: RunSnapshotEvent } | null {
    if (!inflight || typeof inflight !== "object") return null;
    const view = inflight as { messageId?: unknown };
    if (typeof view.messageId !== "string") return null;
    const parsed = RunSnapshotEventSchema.safeParse({
      ...(inflight as Record<string, unknown>),
      sessionId,
    });
    if (!parsed.success) return null;
    return { event: SESSION_WS_EVENTS.runSnapshot, payload: parsed.data };
  }
}
