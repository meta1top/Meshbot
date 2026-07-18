import type { AgentRunEnd, AgentRunFrame } from "@meshbot/types";
import { type RunErrorEvent, SESSION_WS_EVENTS } from "@meshbot/types-agent";
import { FrameSequencer } from "./transport";

interface StreamEntry {
  /** append 模式下 startRun 调用时已知；create 模式初始为 null，首帧到达后回填。 */
  sessionId: string | null;
  sequencer: FrameSequencer;
  /** 是否已收到过至少一帧过程帧——决定 `handleEnd` 是否需要合成收尾事件。 */
  receivedFrame: boolean;
}

interface WatchEntry {
  sessionId: string;
  sequencer: FrameSequencer;
}

/** `AgentRunEnd.reason` → 合成 `run.error` 事件的错误文案（仅在该流从未收到过任何过程帧时使用）。 */
const END_REASON_TEXT: Record<AgentRunEnd["reason"], string> = {
  offline: "对端设备离线，运行未能开始",
  error: "远程运行未能建立",
  interrupted: "远程运行已中断",
  done: "远程运行已结束",
  agent_not_remotable: "目标 Agent 不可远程访问（不存在或未开启远程）",
  session_agent_mismatch: "该会话不属于所选 Agent",
};

/**
 * L3 浏览器侧：单个 `SessionTransport` 实例名下发起的远程 run 流跟踪器，
 * 兼「Agent 级观察通道」（watchId）的前端接收端。纯逻辑（无 socket 依赖），
 * 职责四项：
 *
 * 1. **流归属过滤**——`ws/im` 是浏览器单例 socket，同一连接上可能同时挂着
 *    多个 `createRemoteSessionTransport` 实例（如主视图 + IM dock，各自面向
 *    不同/相同目标设备）。`handleFrame`/`handleEnd` 只处理本实例通过
 *    {@link register} 登记过的 streamId、{@link registerWatch} 登记过的
 *    watchId，其余（属于其它 transport 实例发起/观察的流）一律忽略——不依赖
 *    服务端过滤，纯前端按集合判定。
 * 2. **乱序重排**——每个 streamId/watchId 一个独立 {@link FrameSequencer}
 *    （不同流互不影响，一条流的重排缓冲不会卡住另一条；watch 通道额外开
 *    `primeOnFirst`，见该类文档）。
 * 3. **D6 重复投递抑制**——见 {@link handleFrame} 内联注释。
 * 4. **end 事件合成**——`agent.run.end` 本身多数情况下只是清理信号（B 侧总是
 *    先发 run.done/run.error/run.interrupted 过程帧、才发 end，真正的终止语义
 *    已随过程帧送达，见 `remote-run-inbound.service.ts` 的
 *    `TERMINAL_REASON_BY_EVENT`）；但两种场景下**不会有任何过程帧**：网关判定
 *    目标设备离线（`im.gateway.ts` `handleAgentRunStart`）、B 侧触发失败
 *    （`remote-run-inbound.service.ts` 的 catch 分支）。这两种场景下
 *    `handleEnd` 合成一条 `run.error` 收尾，避免 UI 永远停留在「运行中」。
 *    sessionId 未知（create 模式、且从未收到首帧回报）时无法路由到任何会话
 *    视图，静默返回 null——与 web-agent A 侧 `RemoteRunService.onEnd` 面对同一
 *    协议缺口时的行为一致（该路径下 A 侧也没有把 offline 转译成任何
 *    `SESSION_WS_EVENTS.*`），非本模块引入的新限制，详见任务报告 concerns。
 */
export class RemoteRunTracker {
  private readonly streams = new Map<string, StreamEntry>();
  /**
   * 本实例观察（watch）中的通道：watchId → 条目。与 `streams` 分表的理由——
   * 两者生命周期完全不同：stream 收到 `agentRunEnd` 即销毁（一次性），watch
   * **跨多轮 run 存活**到显式 `releaseWatch`（常驻），混在一张表里必然会被
   * `handleEnd` 的删除逻辑误清。
   */
  private readonly watches = new Map<string, WatchEntry>();

  /**
   * 登记一次本 transport 实例发起的 run（`startRun` 调用后立即调用）。
   * @param sessionId append 模式下已知的目标会话 id；create 模式传 null。
   */
  register(streamId: string, sessionId: string | null): void {
    this.streams.set(streamId, {
      sessionId,
      sequencer: new FrameSequencer(),
      receivedFrame: false,
    });
  }

  /** 该 streamId 是否本实例发起（供调用方短路无需处理的事件）。 */
  owns(streamId: string): boolean {
    return this.streams.has(streamId);
  }

  /**
   * 登记一路观察通道（`watch_accepted{ok:true}` 到达后调用）。
   * sequencer 开 `primeOnFirst`——观察者是中途接入，首帧 seq 不是 1。
   */
  registerWatch(watchId: string, sessionId: string): void {
    this.watches.set(watchId, {
      sessionId,
      sequencer: new FrameSequencer({ primeOnFirst: true }),
    });
  }

  /** 注销一路观察通道（unwatch / 组件卸载）。 */
  releaseWatch(watchId: string): void {
    this.watches.delete(watchId);
  }

  /** 该 watchId 是否本实例登记（供调用方短路无需处理的事件）。 */
  ownsWatch(watchId: string): boolean {
    return this.watches.has(watchId);
  }

  /**
   * 处理一帧 `AgentRunFrame`。按 `streamId` / `watchId` 分流（协议保证二选一）：
   *
   * - `streamId`：本实例**自己发起**的远程 run（既有逻辑，零变化）。
   * - `watchId`：本实例**观察**的通道。此处实现 spec **D6 重复投递抑制**——
   *   若本实例同时持有**同一 sessionId** 的活跃 stream（自己刚发起的那轮），
   *   watch 帧整条丢弃：设备侧对同一会话既走 per-run 转发器（回给发起方）
   *   又走常驻转发器（镜像给观察者），发起方两条都收得到，不抑制就是双份。
   *   按「持有期整段抑制」而非逐帧去重（D6 明确取此策略，简单且无状态爆炸）。
   */
  handleFrame(
    frame: AgentRunFrame,
  ): Array<{ event: string; payload: unknown }> {
    if (frame.watchId) {
      const entry = this.watches.get(frame.watchId);
      if (!entry) return [];
      if (this.hasActiveStreamFor(entry.sessionId)) return []; // D6 抑制
      return entry.sequencer.push({
        seq: frame.seq,
        event: frame.event,
        payload: frame.payload,
      });
    }
    if (!frame.streamId) return [];
    const entry = this.streams.get(frame.streamId);
    if (!entry) return [];
    entry.receivedFrame = true;
    if (entry.sessionId === null && frame.sessionId) {
      entry.sessionId = frame.sessionId;
    }
    return entry.sequencer.push({
      seq: frame.seq,
      event: frame.event,
      payload: frame.payload,
    });
  }

  /** 本实例是否持有该会话的活跃 stream（D6 抑制判定）。 */
  private hasActiveStreamFor(sessionId: string): boolean {
    for (const entry of this.streams.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * 处理流终止 `AgentRunEnd`：非本实例发起的流返回 null（忽略）；已登记的流
   * 清理登记后，若从未收到过任何过程帧则合成一条 `run.error` 收尾事件返回，
   * 否则（真正的终止语义已随过程帧送达）返回 null，调用方不必重复处理。
   */
  handleEnd(end: AgentRunEnd): { event: string; payload: unknown } | null {
    const entry = this.streams.get(end.streamId);
    if (!entry) return null;
    this.streams.delete(end.streamId);
    if (entry.receivedFrame) return null;
    if (entry.sessionId === null) return null;
    return {
      event: SESSION_WS_EVENTS.runError,
      payload: {
        sessionId: entry.sessionId,
        messageId: null,
        pendingIds: [],
        error: END_REASON_TEXT[end.reason],
        // 同时透传结构化 reason：渲染层（MessageList）优先按它走 next-intl
        // 专属文案，上面的中文常量退居兜底（未覆盖到的 reason / 非渲染消费方）。
        reason: end.reason,
      } satisfies RunErrorEvent,
    };
  }

  /** 主动释放指定 streamId 的登记（如调用方判定该流不再需要跟踪）。 */
  release(streamId: string): void {
    this.streams.delete(streamId);
  }

  /** 清空全部登记（stream + watch，transport dispose 时调用，避免与后续新建的
   * 同类型实例混淆残留状态；同一实例也可安全复用——清空后行为等同刚构造）。 */
  reset(): void {
    this.streams.clear();
    this.watches.clear();
  }
}
