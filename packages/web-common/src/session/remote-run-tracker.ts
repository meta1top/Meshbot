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

/** `AgentRunEnd.reason` → 合成 `run.error` 事件的错误文案（仅在该流从未收到过任何过程帧时使用）。 */
const END_REASON_TEXT: Record<AgentRunEnd["reason"], string> = {
  offline: "对端设备离线，运行未能开始",
  error: "远程运行未能建立",
  interrupted: "远程运行已中断",
  done: "远程运行已结束",
};

/**
 * L3 浏览器侧：单个 `SessionTransport` 实例名下发起的远程 run 流跟踪器。
 * 纯逻辑（无 socket 依赖），职责三项：
 *
 * 1. **流归属过滤**——`ws/im` 是浏览器单例 socket，同一连接上可能同时挂着
 *    多个 `createRemoteSessionTransport` 实例（如主视图 + IM dock，各自面向
 *    不同/相同目标设备）。`handleFrame`/`handleEnd` 只处理本实例通过
 *    {@link register} 登记过的 streamId，其余（属于其它 transport 实例发起的
 *    流）一律忽略——不依赖服务端过滤，纯前端按 streamId 集合判定。
 * 2. **乱序重排**——每个 streamId 一个独立 {@link FrameSequencer}（不同流互不
 *    影响，一条流的重排缓冲不会卡住另一条）。
 * 3. **end 事件合成**——`agent.run.end` 本身多数情况下只是清理信号（B 侧总是
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
   * 处理一帧 `AgentRunFrame`：非本实例发起的流返回空数组（忽略）；
   * 已登记的流经该 streamId 专属的 `FrameSequencer` 重排后返回可吐出的事件。
   */
  handleFrame(
    frame: AgentRunFrame,
  ): Array<{ event: string; payload: unknown }> {
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
      } satisfies RunErrorEvent,
    };
  }

  /** 主动释放指定 streamId 的登记（如调用方判定该流不再需要跟踪）。 */
  release(streamId: string): void {
    this.streams.delete(streamId);
  }

  /** 清空全部登记（transport dispose 时调用，避免与后续新建的同类型实例
   * 混淆残留状态；同一实例也可安全复用——清空后行为等同刚构造）。 */
  reset(): void {
    this.streams.clear();
  }
}
