"use client";

import type {
  AgentRunControlInput,
  AgentRunEnd,
  AgentRunFrame,
  AgentRunStartInput,
  AgentWatchAccepted,
  AgentWatchStartInput,
  AgentWatchStopInput,
  DeviceQueryKind,
  DeviceQueryRequestInput,
} from "@meshbot/types";
import { IM_WS_EVENTS } from "@meshbot/types";
import type {
  HistoryResponse,
  PendingResponse,
  SessionSummary,
} from "@meshbot/types-agent";
import { clientSnowflakeId } from "@meshbot/web-common";
import { RemoteRunTracker } from "@meshbot/web-common/session/remote-run-tracker";
import {
  type SessionListEvent,
  toSessionListEvent,
} from "@meshbot/web-common/session/session-list-events";
import {
  MulticastRunEvents,
  type SessionTransport,
} from "@meshbot/web-common/session/transport";
// 特意不走 `@meshbot/web-common/session` 桶装 barrel（`./session`）——那份导出
// 把 `MarkdownContent`/`ArtifactBody` 等一整套 JSX 组件也捆在一起，后者经
// `@meshbot/design` 再传递引入 `next-intl`/`react-markdown` 等纯 ESM 包。本文件
// 只是 socket 事件编排（无 UI），走这三个专属子路径直连纯逻辑源文件，既避免
// 生产 bundle 平白多背一份 UI 依赖，也让本文件可被根 jest.config.ts 直接加载
// 测试（不必拉通整条 JSX 依赖链——曾误以为需要给 web-main 单独建一套 jest
// 基建才能跑通，实测根配置本就吃得下，见 T12 review Finding 8：那套独立基建
// 后来整个删掉了，仅保留下面这几个子路径 exports）。三个子路径已在
// `packages/web-common/package.json` 的 `exports` 显式声明，与既有 `"./session"`
// 直连源码（非 dist）的写法一致。
import { inflightToSnapshotEvent } from "@meshbot/web-common/session/watch-inflight";
import { remoteQuery } from "./device-query";
import { getImSocket } from "./im-socket";

/**
 * 观察通道被云端/设备拒绝时，合成给本 transport 实例 `subscribe()` 消费者的
 * 事件名——纯前端内部信号，不进 `IM_WS_EVENTS` 协议、不占用任何
 * `SESSION_WS_EVENTS.*` 命名空间。`reason` 原样透传自
 * {@link AgentWatchAccepted}（`offline`/`cross_account`/`not_found`/
 * `session_agent_mismatch`/`error`；**不含** `idle`——idle 回收由
 * {@link handleWatchRejected} 原地自动重 watch 吞掉，不会冒泡成这个事件，见
 * 该函数文档）。调用方（`remote-session-view.tsx`）据此渲染「无法实时观察」
 * 的可见提示，走 next-intl 按 reason 分文案——本层不碰 next-intl（铁律），
 * 只负责把信号送出去。
 *
 * 修复上一轮 review 的遗留问题：watch 被拒此前只 `console.warn`，用户完全无
 * 感知（设备离线时界面看着「正常」，实际上永远收不到任何实时帧）。
 */
export const WATCH_REJECTED_EVENT = "watch.rejected";

/** {@link WATCH_REJECTED_EVENT} 的 payload 形状。 */
export interface WatchRejectedEvent {
  sessionId: string;
  reason?: AgentWatchAccepted["reason"];
}

/**
 * 观察通道（重新）受理成功时合成的事件——用于撤下此前可能挂着的
 * {@link WATCH_REJECTED_EVENT} 横幅（T12 review Finding 7：重 watch 成功后
 * 旧横幅还挂着，容易让用户误以为仍然收不到实时帧）。典型触发点：
 * `onReconnect` 换发新 watchId 后这次成功受理、或 idle 回收后的自动重 watch
 * 成功受理。
 */
export const WATCH_ACCEPTED_EVENT = "watch.accepted";

/** {@link WATCH_ACCEPTED_EVENT} 的 payload 形状。 */
export interface WatchAcceptedEvent {
  sessionId: string;
}

/**
 * web-main（B 端浏览器）远程会话 `SessionTransport`：用户 `ws/im` socket 单例
 * （`getImSocket()`）直连 L3 协议帧流——不同于 web-agent，这里没有一层
 * server-agent 帮忙把远程帧影子重发进本地 `SESSION_WS_EVENTS` 总线，浏览器
 * 直接是 L3 的发起方（A），`device.query.*`/`agent.run.*` 六个事件都在这条
 * socket 上原样收发（`im.gateway.ts` 的 `RunRequester` kind:"user" 分支）。
 *
 * 纯逻辑单元（无 socket 依赖，见 `packages/web-common/src/session/`）：
 * - {@link RemoteRunTracker}：run 帧流归属过滤 + 乱序重排 + end 事件合成。
 * - {@link MulticastRunEvents}：`subscribe()` 的多播分发（见下）。
 *
 * deviceQuery 往返（`device.query.*`）走 `device-query.ts` 的**模块级单例**
 * （一个 client + 一个常驻 `deviceQueryResponse` 监听器），不绑 transport 实例——
 * 否则 remount 时会丢掉尚未 settle 的响应（详见该文件）。本工厂只注册
 * `agentRunFrame`/`agentRunEnd` 两个 run 帧监听器（随 transport 实例，`dispose` 摘除）。
 *
 * `subscribe()` 是**多播**语义（{@link MulticastRunEvents}），并发多路订阅同时
 * 生效：dispatch_subagent 的父子会话共享同一父 `streamId`（B 端按
 * `allowedSessions` 白名单把子会话事件也转发到这同一条流），父会话视图与
 * 嵌套子代理卡因此必须复用**同一个** transport 实例才能都收到帧——早期实现
 * 曾用单一 `current` 指针，后订阅者会覆盖前订阅者，导致先订阅的一方永久收不到
 * 帧（T11 报告 finding 1）。各订阅者内部（`useSessionStream` 的
 * `e.sessionId !== sessionId` 过滤）自行区分哪些广播事件属于自己的会话。
 *
 * 调用方应对同一 agentId 用 `useMemo` 稳定一份 transport 实例（同 web-agent
 * 惯例），嵌套子代理卡复用父组件传入的同一实例（不再各自新建），并在 unmount
 * 时调用 {@link dispose} 释放三个 socket 监听器（子卡不自行 dispose，归父组件
 * 统一管理生命周期）。
 *
 * `agentId`：目标云端 Agent id（计划二 2b · T7：寻址从设备细化到设备上的某
 * Agent，协议字段改名 `targetAgentId`，不再是设备 id）。
 */
export function createRemoteSessionTransport(
  agentId: string,
): SessionTransport {
  const socket = getImSocket();
  const runs = new RemoteRunTracker();
  const runEvents = new MulticastRunEvents();

  const onRunFrame = (frame: AgentRunFrame) => {
    // Agent 级观察通道（`watchAgent`，T15 · ⭐ 交付点 B）：帧承载的是会话
    // 生命周期事件（created/deleted/renamed/status_changed），不是某个具体
    // 会话的推理过程流——归一后直接调用 `watchAgent` 登记的回调，不进
    // `runEvents`（run 流多播，消费方按 sessionId 过滤，生命周期事件没有
    // 单一 sessionId 可挂靠，塞进去也不会被任何会话视图认领）。非生命周期
    // 帧（理论上不该出现在 agent 级通道，纯防御）`toSessionListEvent` 返回
    // null，原样丢弃，不触发回调。`activeWatches` 声明在本函数下方——
    // `onRunFrame` 只在 socket 事件到达时才被调用，届时整段同步初始化早已
    // 跑完，闭包读到的是完整登记表，不是 TDZ 问题。
    const watchHandle = frame.watchId
      ? activeWatches.get(frame.watchId)
      : undefined;
    const emitted = runs.handleFrame(frame);
    if (watchHandle?.scope === "agent") {
      for (const { event, payload } of emitted) {
        const evt = toSessionListEvent(event, payload);
        if (evt) watchHandle.onLifecycleEvent?.(evt);
      }
      return;
    }
    for (const { event, payload } of emitted) {
      runEvents.emit(event, payload);
    }
  };
  const onRunEnd = (end: AgentRunEnd) => {
    const synthesized = runs.handleEnd(end);
    if (synthesized) runEvents.emit(synthesized.event, synthesized.payload);
  };
  // deviceQueryResponse 监听器不在此注册——它挂在 device-query.ts 的模块级单例上
  // （见该文件说明：per-instance 监听器会在 remount 时丢掉尚未 settle 的响应）。
  socket.on(IM_WS_EVENTS.agentRunFrame, onRunFrame);
  socket.on(IM_WS_EVENTS.agentRunEnd, onRunEnd);

  /**
   * 一路 watch 通道的稳定订阅句柄：`watchId` 会在重连（D5）/ idle 自动重连
   * （Finding 5）后原地换新，`watchSession()` 返回的 `unwatch` 闭包必须通过
   * 这个句柄间接寻址「当前」watchId，绝不能直接捕获首次拿到的 watchId 常量
   * ——否则重连后旧 watchId 已经是云端认不出的僵尸值，`unwatch()` 停不掉真正
   * 在用的新通道，旧通道要等满 5 分钟 idle 才回收；期间若用户切走又切回同一
   * 会话，云端 `sessionWatchers` 索引下同时挂着僵尸通道与新通道，同一条
   * run.chunk 帧被 fan-out 两次，正文逐字重复渲染（T12 review Finding 2，
   * 实测复现）。`startWatch` 每次（含首次 / 重连 / idle 重连）都原地覆写
   * `sessionId`/`watchId` 字段，句柄对象本身的引用不变。
   */
  interface WatchHandle {
    /** scope="session" 时为被观察的会话 id；scope="agent" 时恒为空串占位——
     * Agent 级没有单一 sessionId 语义，这个空串只喂给
     * `RemoteRunTracker.registerWatch`/`hasActiveStreamFor` 的 D6 抑制判定，
     * 后者对 `""` 恒返回 false（天然不抑制，真实 stream 的 sessionId 不可能
     * 是空串），语义上完全无害（T15 · ⭐ 交付点 B）。 */
    sessionId: string;
    /** 当前有效的 watchId；未发起过真正的 `agent.watch.start`（见下方
     * `deferredWatches`）时为空串。 */
    watchId: string;
    /** `unwatch()` 是否已调用——幂等 + 防止 idle 自动重连「救活」一个用户
     * 已经不关心的会话（`onWatchAccepted` 据此短路悬空句柄）。 */
    stopped: boolean;
    /** 观察范围：`session`（既有 D5 会话级 watch）| `agent`（T15 新增，会话
     * 生命周期镜像）。决定 `onWatchAccepted`/`onRunFrame` 的分支行为——
     * agent 级不合成 D7 inflight 快照（该续传语义只对单一会话成立），受理帧
     * 也不进 `runEvents`（run 流多播），而是过 `toSessionListEvent` 归一后
     * 直接调用 `onLifecycleEvent`。 */
    scope: "session" | "agent";
    /** 仅 `scope==="agent"` 时存在：生命周期事件回调（`watchAgent` 的入参）。
     * `onRunFrame` 对非生命周期帧（推理过程帧等）不会调用它——`toSessionListEvent`
     * 返回 null 时原样丢弃，不冒泡成任何事件。 */
    onLifecycleEvent?: (evt: SessionListEvent) => void;
  }

  /** watchId → 该通道观察的句柄，仅**已受理**的通道（重连重 watch 与 unwatch 用）。 */
  const activeWatches = new Map<string, WatchHandle>();
  /** watchId → 句柄，**受理前**的通道（`watch_accepted` 到达前的窗口期）。 */
  const pendingWatches = new Map<string, WatchHandle>();
  /**
   * 尚未真正发起（`socket.connected===false` 时调用 `watchSession`）的句柄——
   * 真正的 `emit` 延后到下一次 `"connect"` 触发时统一发起（见 `startWatch`
   * 顶部注释 / T12 review Finding 3）。
   */
  const deferredWatches = new Set<WatchHandle>();

  /**
   * 发起一路 watch（Session 级或 Agent 级，写入 `handle`，受理前先记
   * pending）。目标（会话 id / 无目标）与范围一律从 `handle` 上读，调用方
   * 在构造/复用 `handle` 时已经把这些字段填好——`startWatch` 只负责「按
   * handle 当前状态真正发起一次」，不关心是初次调用、断线重连（D5）还是
   * idle 自动重连（Finding 5），三处调用方式完全一致（T15 · ⭐ 交付点 B：
   * 从「只服务 session 级」扩成「session/agent 共用同一套发起/重连/回收
   * 逻辑」，不新开一条平行路径）。
   *
   * 首连时机注意（Finding 3）：socket.io 的 `onconnect` 内部实现是先
   * `emitBuffered()` 再触发 `"connect"` 保留事件——若本函数在
   * `!socket.connected` 时仍然直接 `socket.emit`，包会被 socket.io 自己的
   * 发送缓冲区接住、在真正连上时**先于**我们的 `onReconnect` 监听器自动
   * flush 出去；`onReconnect` 随后又会把这条 pending 判定成「需要换新 id
   * 重新发起的旧通道」再发一条——云端因此收到同一目标的两条
   * `agent.watch.start`，一条永远等不到我们确认、要等满 5 分钟 idle 才回收，
   * 期间持续白白多扇一份帧。故未连接时不真正 `emit`，只登记进
   * `deferredWatches`，交给 `onReconnect`（首连也会触发一次 `"connect"`）
   * 统一在真正连接建立后发起。
   */
  const startWatch = (handle: WatchHandle): void => {
    if (!socket.connected) {
      deferredWatches.add(handle);
      return;
    }
    const watchId = clientSnowflakeId();
    handle.watchId = watchId;
    pendingWatches.set(watchId, handle);
    // scope="agent" 不携带 sessionId 字段（不是置为 undefined——协议层
    // `AgentWatchStartSchema` 对 scope="agent" 未要求也未使用它，多带一个
    // 空字段没有意义；相应地 handle.sessionId 对 agent 级恒为占位空串，
    // 见 `WatchHandle.sessionId` 文档）。
    const body: AgentWatchStartInput =
      handle.scope === "agent"
        ? { watchId, targetAgentId: agentId, scope: "agent" }
        : {
            watchId,
            targetAgentId: agentId,
            scope: "session",
            sessionId: handle.sessionId,
          };
    socket.emit(IM_WS_EVENTS.agentWatchStart, body);
  };

  /**
   * 停掉一路 watch（`watchSession`/`watchAgent` 返回的 unwatch 闭包共用）。
   * 幂等（`handle.stopped` 短路）；捕获的是 {@link WatchHandle} 对象本身、
   * 不是某个 watchId 快照——`handle.watchId` 会在重连 / idle 自动重连时被
   * `startWatch` 原地覆写，这里读的永远是「当前」值（T12 review Finding 2，
   * `watchAgent` 复用同一份，不重新踩坑）。
   */
  const stopWatch = (handle: WatchHandle): void => {
    if (handle.stopped) return;
    handle.stopped = true;
    deferredWatches.delete(handle);
    activeWatches.delete(handle.watchId);
    pendingWatches.delete(handle.watchId);
    runs.releaseWatch(handle.watchId);
    if (handle.watchId) {
      // 尚未真正发起过（一直卡在 deferredWatches，从未连接成功就被
      // unwatch）时 watchId 是空串，不必也不能发 stop。
      socket.emit(IM_WS_EVENTS.agentWatchStop, {
        watchId: handle.watchId,
      } satisfies AgentWatchStopInput);
    }
  };

  /**
   * 把 `accepted.inflight` 合成 `run.snapshot` 吐给订阅者（D7 中途续上），
   * 但先过一次 D6 同款「本实例是否持有该 sessionId 的活跃 stream」判定
   * （T12 review Finding 4）：`hasActiveStreamFor` 原本只抑制 watch **帧**，
   * 但这里的 emit 此前是无条件的——若本实例自己正在流式输出同一会话
   * （如新建会话首帧刚回报 sessionId、watch effect 随即触发），watch 受理
   * 带回的 inflight 快照几乎总比已累积的内容更旧，直接 emit 会把正文（SET
   * 覆盖语义，见 `useSessionStream.onSnapshot`）回退一段，之后的增量帧接在
   * 旧基线上，中间那段永久丢失，要到 run.done 全量 SET 才自愈。复用
   * tracker 已有的判定，不新写一套。
   */
  const emitInflightSnapshot = (sessionId: string, inflight: unknown) => {
    if (runs.hasActiveStreamFor(sessionId)) return;
    const snapshot = inflightToSnapshotEvent(sessionId, inflight);
    if (snapshot) runEvents.emit(snapshot.event, snapshot.payload);
  };

  /**
   * 通道被拒（`ok:false`）的统一处理，pending / 已受理两条路径共用
   * （见 {@link onWatchAccepted}）。
   *
   * `reason==="idle"`：云端 idle 清扫回收（Finding 5）——宿主设备大概率仍
   * 在线，只是这条通道长时间无帧活动被清扫，不是真的「连不上」。原地复用
   * 同一句柄自动重新发起（`startWatch` 覆写 `handle.watchId`，外部持有的
   * `unwatch` 闭包因此始终寻址到新 id），组件侧无感知，不弹横幅打扰用户
   * 手动救；`handle.stopped` 由 `onWatchAccepted` 的查表短路天然保证——若
   * 组件已经 unwatch/卸载，句柄早已从 `activeWatches`/`pendingWatches` 摘除，
   * 这条分支根本不会被走到。
   *
   * 其余 reason：真正的失败（设备离线 / 不可远程 / 会话不归属 / 跨账号 /
   * 设备处理出错），合成 {@link WATCH_REJECTED_EVENT} 交给 `subscribe()`
   * 消费者渲染可见提示（上一轮 review 明确指出「不能只 console.warn」）。
   */
  const handleWatchRejected = (
    handle: WatchHandle,
    reason: AgentWatchAccepted["reason"],
  ) => {
    if (reason === "idle") {
      startWatch(handle);
      return;
    }
    console.warn(`观察通道被拒（watchId=${handle.watchId}, reason=${reason}）`);
    runEvents.emit(WATCH_REJECTED_EVENT, {
      sessionId: handle.sessionId,
      reason,
    } satisfies WatchRejectedEvent);
  };

  const onWatchAccepted = (accepted: AgentWatchAccepted) => {
    const pendingHandle = pendingWatches.get(accepted.watchId);
    if (pendingHandle) {
      pendingWatches.delete(accepted.watchId);
      if (!accepted.ok) {
        handleWatchRejected(pendingHandle, accepted.reason);
        return;
      }
      activeWatches.set(accepted.watchId, pendingHandle);
      // Agent 级没有单一 sessionId 语义——`registerWatch` 传占位空串（见
      // `WatchHandle.sessionId` 文档），`RemoteRunTracker.hasActiveStreamFor`
      // 因此对它恒返回 false，天然不抑制生命周期帧（T15 brief 明确的既有
      // 行为，不需要额外分支）。
      runs.registerWatch(accepted.watchId, pendingHandle.sessionId);
      // D7 inflight 续传快照 / `watch.accepted` 横幅信号都是 session 级观察
      // 通道专属语义（前者要接到某条具体会话的正文流上、后者供某个会话视图
      // 撤下自己的「无法实时观察」提示）——agent 级没有这两样东西可挂靠
      // （`sessionId` 是占位空串，`accepted.inflight` 按 T14 设备侧实现恒为
      // null），跳过而非无条件复用，避免把一个空 sessionId 的事件塞进
      // `runEvents`（run 流多播，消费方按 sessionId 过滤，塞一条不会被任何
      // 会话视图认领，纯属噪音）。
      if (pendingHandle.scope === "session") {
        emitInflightSnapshot(pendingHandle.sessionId, accepted.inflight);
        runEvents.emit(WATCH_ACCEPTED_EVENT, {
          sessionId: pendingHandle.sessionId,
        } satisfies WatchAcceptedEvent);
      }
      return;
    }
    // 回落：已受理的通道事后被拒（T12 review Finding 1）——宿主设备断线
    // （`im.gateway.ts` `notifyWatcherOffline`）或 idle 回收都是针对**已受理**
    // 的 watchId 补发 `agentWatchAccepted{ok:false}`，此时 pendingWatches 早已
    // 在受理时清空，只在 activeWatches 里查得到。此前的实现只查
    // pendingWatches、miss 就静默 return，导致这两种此任务要解决的头号场景
    // 全部被吃掉：横幅永不出现，activeWatches/runs.watches 里的死 watchId
    // 也永不清理。
    const activeHandle = activeWatches.get(accepted.watchId);
    if (!activeHandle || accepted.ok) return; // 非本实例的 watch / 协议不会对已激活通道重复回 ok:true，防御性忽略
    activeWatches.delete(accepted.watchId);
    runs.releaseWatch(accepted.watchId);
    handleWatchRejected(activeHandle, accepted.reason);
  };

  /**
   * 断线重连自动重 watch（D5）：云端在观察者 socket 断开时已把该连接的全部
   * watch 路由清掉（泄漏防线 2），重连后是一条**新 socket**（socketId 变了，
   * requester 身份也变了），必须用**新 watchId** 重新发起——沿用旧 watchId 会
   * 在云端建出一条 requester 指向已死 socketId 的路由。
   *
   * 首连也会触发一次 `"connect"`：此时 `activeWatches`/`pendingWatches` 恒为
   * 空（`startWatch` 在未连接时只登记进 `deferredWatches`，见其文档），本段
   * 循环天然是空操作，真正要处理的是下面 `deferredWatches` 那段。
   */
  const onReconnect = () => {
    const liveHandles = [
      ...new Set([...activeWatches.values(), ...pendingWatches.values()]),
    ];
    activeWatches.clear();
    pendingWatches.clear();
    runs.resetWatches();
    for (const handle of liveHandles) {
      if (handle.stopped) continue; // 防御：理论上 stopped 句柄不会残留在这两张表里
      startWatch(handle);
    }
    // 连接建立前就调用过 watchSession/watchAgent 的句柄：此刻 socket 已连接，
    // startWatch 会走正常分支真正 emit + 登记 pending（Finding 3）。
    const deferred = [...deferredWatches];
    deferredWatches.clear();
    for (const handle of deferred) {
      if (handle.stopped) continue;
      startWatch(handle);
    }
  };

  socket.on(IM_WS_EVENTS.agentWatchAccepted, onWatchAccepted);
  socket.on("connect", onReconnect);

  const query = (
    kind: DeviceQueryKind,
    params: DeviceQueryRequestInput["params"],
  ) => remoteQuery(agentId, kind, params);

  const control = (body: AgentRunControlInput) =>
    socket.emit(IM_WS_EVENTS.agentRunControl, body);

  return {
    capabilities: { localRun: false },

    async listSessions() {
      return (await query("sessions", {})) as SessionSummary[];
    },

    /**
     * 跨设备取历史。`as HistoryResponse` 现在是**真实成立**的断言，不再是编译期
     * 谎言：B 侧 `RemoteQueryInboundService` 的 history 分支已与本地 REST 共用
     * 同一份 `assembleHistoryMessages`，回的就是 `HistoryResponse`（工具状态/
     * 结果/subSessionId 合并完毕、role="tool" 行已过滤）。此前该分支直出裸 ORM
     * 行，这句强转把形状不符一路掩盖到运行时，前端只好防御式补救。
     *
     * 本层不加 Zod parse：`device.query` 通道对所有 kind 一律是 `unknown` 出参 +
     * 调用点断言（见本文件 `listSessions`/`readArtifact` 等），单独给 history 开
     * 运行时校验会与该惯例不一致；且校验失败只能整屏报错，不比
     * `historyMessageToTimeline` 里逐字段兜底更有用（对端设备可能是旧版
     * server-agent，那里有 `Array.isArray` 守卫兜住）。
     */
    async fetchHistory(sessionId, opts) {
      return (await query("history", {
        sessionId,
        before: opts?.before,
        limit: opts?.limit,
      })) as HistoryResponse;
    },

    async startRun(input) {
      // messageId（本地乐观插入气泡 id）不使用：远程续写由 B 侧自行生成
      // messageId（randomUUID），前端无法提前得知，契约注释已明确此限制。
      const streamId = clientSnowflakeId();
      runs.register(streamId, input.sessionId ?? null);
      socket.emit(IM_WS_EVENTS.agentRunStart, {
        streamId,
        targetAgentId: agentId,
        mode: input.mode,
        sessionId: input.sessionId,
        content: input.content,
      } satisfies AgentRunStartInput);
      return { streamId };
    },

    async interrupt(streamId, sessionId) {
      if (!streamId) {
        console.warn(
          "远程会话当前无可用 streamId，无法中断（可能是刷新/直接进入一个仍在跑的远程会话）",
        );
        return;
      }
      control({
        streamId,
        targetAgentId: agentId,
        sessionId,
        kind: "interrupt",
      });
    },

    async confirm(streamId, sessionId, toolCallId, decision, content) {
      if (!streamId) {
        throw new Error("远程会话 streamId 未就绪，请稍候重试");
      }
      control({
        streamId,
        targetAgentId: agentId,
        sessionId,
        kind: "confirm",
        toolCallId,
        decision,
        content,
      });
    },

    async answer(streamId, sessionId, toolCallId, answers) {
      if (!streamId) {
        throw new Error("远程会话 streamId 未就绪，请稍候重试");
      }
      control({
        streamId,
        targetAgentId: agentId,
        sessionId,
        kind: "answer",
        toolCallId,
        answers,
      });
    },

    async patchSessionModel(sessionId, modelConfigId) {
      await query("patch-session-model", { sessionId, modelConfigId });
    },

    async fetchPending(_sessionId): Promise<PendingResponse> {
      // 远程 relay 无「排队未处理」语义（同 web-agent 远程工厂）——
      // use-session-stream 只在 local 分支调用本方法，如实抛错而非伪造空结果。
      throw new Error(
        "远程会话不支持 pending 查询（SessionTransport.fetchPending 仅本地会话适用）",
      );
    },

    async fetchActiveRun(_sessionId) {
      // 契约偏差（见任务报告 concerns）：web-agent 的远程实现能查到 streamId
      // reclaim，是因为 A 侧有一个常驻的 server-agent 进程，用 REST 端点查询它
      // 本地维护的 (targetDeviceId, sessionId) → streamId 内存表
      // （`RemoteRunService.findRunBySession`）。web-main 的浏览器连接是
      // L3 协议里真正的「A」，没有这样一层常驻进程可查——L3 协议本身
      // （`DeviceQueryKindSchema`）也没有提供按 sessionId 反查 streamId 的
      // query kind，`im.gateway.ts` 的 `agentRunRoutes` 只能按 streamId 正向查，
      // 无 sessionId 反向索引。刷新页面 / 直接进入一个仍在跑的远程会话时无法
      // reclaim，如实抛错而非伪造 null（伪造 null 会让调用方误以为「查过了，
      // 确实没有活跃 run」，而不是「这个能力压根不存在」）。
      throw new Error(
        "web-main 远程会话暂不支持 streamId reclaim（L3 协议未提供按 sessionId 反查 streamId 的通道）",
      );
    },

    async readArtifact(sessionId, path) {
      return (await query("artifact-file", {
        sessionId,
        filePath: path,
      })) as
        | { kind: "content"; name: string; base64: string }
        | { kind: "too-large"; name: string; size: number };
    },

    async uploadArtifactToDrive(sessionId, path) {
      return (await query("artifact-upload-drive", {
        sessionId,
        filePath: path,
      })) as { fileId: string; name: string };
    },

    /**
     * 开始观察某会话的推理帧（Session 级 watch，spec D5「打开会话即
     * session-watch」）。返回 unwatch 函数（幂等）——调用方在会话视图卸载 /
     * 切换会话时必须调用，否则设备侧常驻转发器要等满 5 分钟 idle 才拆
     * （能兜住，但白占资源）。
     *
     * 返回的 unwatch 闭包捕获的是 {@link WatchHandle} 对象本身、不是某个
     * watchId 快照——`handle.watchId` 会在重连 / idle 自动重连时被 `startWatch`
     * 原地覆写，闭包读的永远是「当前」值（T12 review Finding 2）。
     */
    watchSession(sessionId: string) {
      const handle: WatchHandle = {
        sessionId,
        watchId: "",
        stopped: false,
        scope: "session",
      };
      startWatch(handle);
      return () => stopWatch(handle);
    },

    /**
     * 开始观察该 Agent 的会话生命周期（Agent 级 watch，T15 · ⭐ 交付点
     * B——「A 远程建的会话，B 上实时出现」端到端可用的前端接线点）。与
     * `watchSession` 共用同一套 `startWatch`/`stopWatch`/`onReconnect`/
     * idle 自动重连逻辑，只是 `scope="agent"` 且没有单一 `sessionId`（占位
     * 空串，见 `WatchHandle.sessionId` 文档）——`onRunFrame` 据此把受理帧
     * 归一（`toSessionListEvent`）后直接调用 `onEvent`，不进 `runEvents`。
     *
     * 返回的 unwatch 闭包同样捕获 {@link WatchHandle} 对象本身（T12 review
     * Finding 2 的稳定句柄模式），重连 / idle 自动重连换发新 watchId 后仍能
     * 停掉「当前」通道。
     */
    watchAgent(onEvent: (evt: SessionListEvent) => void) {
      const handle: WatchHandle = {
        sessionId: "",
        watchId: "",
        stopped: false,
        scope: "agent",
        onLifecycleEvent: onEvent,
      };
      startWatch(handle);
      return () => stopWatch(handle);
    },

    subscribe(events) {
      return runEvents.subscribe(events);
    },

    dispose() {
      // run 帧监听器挂在 module 级单例 socket（`getImSocket()`）上，不随 transport
      // 实例 GC 自动摘除——组件 unmount 时必须显式 off，否则每次 remount（导航切换
      // 会话/设备）都会累积一份，重复触发 `runs.handleFrame`。deviceQueryResponse
      // 监听器归 device-query.ts 单例常驻，不在此摘除。
      socket.off(IM_WS_EVENTS.agentRunFrame, onRunFrame);
      socket.off(IM_WS_EVENTS.agentRunEnd, onRunEnd);
      // 释放本实例名下全部 watch（含尚未受理的 / 尚未真正发起的 deferred）——
      // 泄漏防线：remount / 切 agentId 时若不主动 stop，旧通道要等设备侧 5
      // 分钟 idle 才拆。
      for (const handle of [
        ...activeWatches.values(),
        ...pendingWatches.values(),
        ...deferredWatches,
      ]) {
        handle.stopped = true;
        if (handle.watchId) {
          socket.emit(IM_WS_EVENTS.agentWatchStop, {
            watchId: handle.watchId,
          } satisfies AgentWatchStopInput);
        }
      }
      activeWatches.clear();
      pendingWatches.clear();
      deferredWatches.clear();
      socket.off(IM_WS_EVENTS.agentWatchAccepted, onWatchAccepted);
      socket.off("connect", onReconnect);
      runs.reset();
      runEvents.reset();
    },
  };
}
