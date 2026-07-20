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
import { RemoteRunService } from "./remote-run.service";

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
    /**
     * D6 重复投递抑制对账依赖（修复重复投递 Critical）：session 级观察帧与
     * `RemoteRunService` 自己发起的 streamId 帧同源（B 侧两个转发器各自
     * 镜像同一份 `SESSION_WS_EVENTS.*`），本实例若同时持有该会话的自发起
     * stream，说明 `RemoteRunService.onFrame` 已经转发过一份，本服务必须
     * 抑制，见下方 {@link onFrame}/{@link onAccepted} 内联注释。
     */
    private readonly remoteRun: RemoteRunService,
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

  /**
   * 显式注销观察：经 relay 上行 `agent.watch.stop` 并解除本地登记。
   *
   * **必须先校验归属**（review 阻塞项）：不比对 `entry.cloudUserId` 就无条件
   * 删本地条目的话，账号 u1 拿 u2 的 watchId 调这个端点会造成——云端因
   * `sameRequester` 全等校验拒绝真正拆除（那条通道**还活着**，见
   * `server-main/src/ws/im.gateway.ts` 的「泄漏防线 4」），而本地条目已经没了；
   * 此后云端继续为该 watchId 扇帧，本地 `onFrame`/`onAccepted` 因查不到 entry
   * 静默丢弃，u2 的浏览器那条通道**无声死掉**，连 `ok:false` 都收不到
   * （本地压根没转发这次拒绝）。
   *
   * 这与 `RemoteRunService.sendControl` 的「转发即可、云端自己拒」不是一回事：
   * 那个方法不碰任何本地状态，云端拒绝就没有副作用；而本方法**无论云端受不
   * 受理都会先动本地状态**，所以本地必须自己先把好门。
   *
   * 归属不符按「查无此 watch」静默返回（与云端同语义），不抛错——避免把
   * 「这个 watchId 存在但不属于你」这个事实回给调用方。
   */
  stopWatch(cloudUserId: string, watchId: string): void {
    const entry = this.watches.get(watchId);
    if (!entry || entry.cloudUserId !== cloudUserId) return;
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
      // D6 重复投递抑制：B 侧同一 sessionId 上 per-run 转发器
      // （RemoteRunInboundService）与常驻转发器（SessionWatchService）各自
      // 独立订阅同一份本地 SESSION_WS_EVENTS.*、各自打包回发——本实例若同时
      // 是这条会话的自发起方（RemoteRunService 有一条活跃 streamId 订阅），
      // RemoteRunService.onFrame 早已转发过同一份内容一次，这里再转发就是
      // 纯重复正文，直接丢弃不 emit。与 web-main RemoteRunTracker.handleFrame
      // 的 D6 判定同源，但本服务不需要「先 push 进 FrameSequencer 记账再丢弃」
      // 那道额外步骤——那是为了不冻结浏览器端按 seq 重排序的
      // nextExpectedSeq；本服务从不消费 frame.seq 做重排序（A 到浏览器这段是
      // 本机单连接 socket.io，天然有序，session.gateway.ts 的
      // onRemoteShadowFrame 直通转发、无缓冲/无计数状态），故直接 return 不
      // 存在同类通道卡死风险（已核实 packages/web-common/src/session/
      // remote-run-tracker.ts:130-142 那段坑不适用于本文件）。
      if (
        entry.sessionId &&
        this.remoteRun.hasActiveStreamFor(entry.targetAgentId, entry.sessionId)
      ) {
        return;
      }
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
   *
   * **同根因第二症状（与 onFrame 的 D6 共用同一判定，逐字对齐 web-main T12
   * review Finding 4）**：若本实例同时持有该会话的自发起 stream，说明 A 早已
   * 经 `RemoteRunService` 实时收着这条会话的正文——`inflight` 是 B 侧
   * `watch_accepted` 回包这一刻的快照，很可能已经落后于本地已累积的正文；
   * `useSessionStream.onSnapshot` 对正文是 **SET 覆盖**而非累加，无条件补发
   * 会把已经流到一半的正文回退一段。故同样先查 `hasActiveStreamFor` 再决定
   * 是否合成/补发，命中则跳过（本实例已经有更新鲜的数据源，不需要这份快照）。
   */
  @OnEvent(IM_RELAY_EVENTS.agentWatchAcceptedInbound)
  onAccepted(accepted: AgentWatchAccepted): void {
    if (!accepted.ok) {
      this.watches.delete(accepted.watchId);
      return;
    }
    const entry = this.watches.get(accepted.watchId);
    if (!entry || entry.scope !== "session" || !entry.sessionId) return;
    if (
      this.remoteRun.hasActiveStreamFor(entry.targetAgentId, entry.sessionId)
    ) {
      return;
    }
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
