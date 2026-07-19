import {
  SESSION_WS_EVENTS,
  type RunSubagentSettledEvent,
  type RunSubagentSpawnedEvent,
  type RunToolCallEndEvent,
} from "@meshbot/types-agent";
import type { EventEmitter2 } from "@nestjs/event-emitter";

/**
 * 需要转发出设备的 `SESSION_WS_EVENTS.*` 全集（`session.subscribe` /
 * `unsubscribe` / `interrupt` 是客户端上行 socket 消息、`runSnapshot` 只在
 * 订阅时点对点补发，均不经 EventEmitter2 广播，转发这些名字永远收不到事件，
 * 故排除；其余 18 个由 RunnerService / ContextCompactor / DispatchSubagentService /
 * SessionTitleService 经 EventEmitter2 广播，逐个转发）。
 */
export const FORWARDED_SESSION_EVENTS: readonly string[] = [
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

/** 终止事件 → 终止原因映射。 */
const TERMINAL_REASON_BY_EVENT: ReadonlyMap<
  string,
  "done" | "error" | "interrupted"
> = new Map([
  [SESSION_WS_EVENTS.runDone, "done"],
  [SESSION_WS_EVENTS.runError, "error"],
  [SESSION_WS_EVENTS.runInterrupted, "interrupted"],
]);

/**
 * run.tool_call_end 转发前剥掉 `content` 字段（可能很大，如长文件读取结果）。
 * 与 `session.gateway.ts` 对本地前端的处理保持一致——前端只用 `resultPreview`
 * 渲染，`content` 没必要经 relay 跨设备中继一份，白白浪费带宽/体积。
 */
function stripToolCallEndContent(
  payload: RunToolCallEndEvent,
): Omit<RunToolCallEndEvent, "content"> {
  const { content: _content, ...rest } = payload;
  return rest;
}

/** 转发出去的一帧（调用方据此组 `AgentRunFrame` 或 `AgentWatchFrame`）。 */
export interface ForwardedFrame {
  seq: number;
  sessionId: string;
  event: string;
  payload: unknown;
}

/** 转发目的地。调用方实现，决定这些帧最终怎么发（streamId 寻址 / watch 镜像）。 */
export interface SessionFrameSink {
  onFrame(frame: ForwardedFrame): void;
  /**
   * 主会话终止（run.done / run.error / run.interrupted）。
   * 子会话（subagent）的终止事件**不**触发本回调——否则子代理一跑完整条流就断。
   */
  onTerminal?(reason: "done" | "error" | "interrupted"): void;
}

/**
 * 会话帧转发器：订阅某 sessionId 的 `SESSION_WS_EVENTS.*` 全集，按动态过滤
 * 集合 `allowedSessions` 过滤后交给 {@link SessionFrameSink}。
 *
 * 从 `RemoteRunInboundService.subscribeAndForward` 抽取（行为零变化），供两种
 * 生命周期共用：
 * - **per-run**（`stopOnTerminal=true`）：远程 run 的一次性转发，主会话终止即
 *   自动 `stop()`，与抽取前完全一致。
 * - **常驻**（`stopOnTerminal=false`）：Agent 级观察通道的 Session 级 watch，
 *   **不在 run 终止时退订**，跨多轮 run 存活到 unwatch / idle 拆除。这是常驻
 *   转发器与 per-run 的**本质差异**，也是本设计最需防的泄漏点——调用方必须
 *   自行保证 `stop()` 一定被调到（见 `SessionWatchService` 的 idle 拆除）。
 *
 * **allowedSessions 动态集合**：集合初始只含主 sessionId；收到
 * `runSubagentSpawned`（主会话事件，携带 `subSessionId`）→ 把子会话 id 并入，
 * 子会话的 runChunk 等过程事件才能进帧；收到 `runSubagentSettled` → 移出。
 * 这套逻辑在抽取中必须完整保留（spec §C2 明确点名）。
 *
 * 按动态 sessionId 集合精确过滤的理由：设备上可能有多个会话 / 多个 run 并行，
 * 同一事件名会被多个转发器各自的监听器收到，只有 `payload.sessionId` 命中本
 * 实例登记的集合才转发，防止跨会话串台。
 */
export class SessionFrameForwarder {
  private seq = 0;
  private readonly allowedSessions: Set<string>;
  private readonly registered: Array<{
    event: string;
    handler: (payload: unknown) => void;
  }> = [];
  private started = false;

  constructor(
    private readonly emitter: EventEmitter2,
    private readonly sessionId: string,
    private readonly sink: SessionFrameSink,
    private readonly stopOnTerminal: boolean,
  ) {
    this.allowedSessions = new Set<string>([sessionId]);
  }

  /** 当前是否持有监听器（`start()` 后为 true，`stop()` 后为 false）。 */
  get active(): boolean {
    return this.started;
  }

  /** 挂上 `FORWARDED_SESSION_EVENTS` 全集的监听器。幂等（已启动则空操作）。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const event of FORWARDED_SESSION_EVENTS) {
      const handler = (payload: unknown): void => this.handle(event, payload);
      this.emitter.on(event, handler);
      this.registered.push({ event, handler });
    }
    // PROBE-TS 临时排查埋点（云端工具卡永不收敛）——定位后整块删除
    console.warn(
      `[PROBE-TS][fwd-start] sid=${this.sessionId} 注册 ${this.registered.length} 个事件；tool 四件套实际登记名=${JSON.stringify(
        this.registered
          .map((r) => r.event)
          .filter((e) => String(e).includes("tool_call")),
      )}；emitter 上各自 listenerCount=${JSON.stringify(
        Object.fromEntries(
          [
            SESSION_WS_EVENTS.runToolCallStart,
            SESSION_WS_EVENTS.runToolCallProgress,
            SESSION_WS_EVENTS.runToolCallArgsDelta,
            SESSION_WS_EVENTS.runToolCallEnd,
          ].map((e) => [String(e), this.emitter.listenerCount(e)]),
        ),
      )}`,
    );
  }

  /** 摘除本实例登记的全部监听器。幂等（未启动 / 已停止均安全）。 */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    for (const { event, handler } of this.registered) {
      this.emitter.off(event, handler);
    }
    this.registered.length = 0;
  }

  private handle(event: string, payload: unknown): void {
    const payloadSessionId = (payload as { sessionId?: unknown })?.sessionId;
    // PROBE-TS 临时排查埋点（云端工具卡永不收敛）——定位后整块删除
    if (event.startsWith("run.tool_call")) {
      const p = payload as { messageId?: string; toolCallId?: string };
      console.warn(
        `[PROBE-TS][device] ${event} sid=${String(payloadSessionId)} allowed=${
          typeof payloadSessionId === "string" &&
          this.allowedSessions.has(payloadSessionId)
        } msg=${p?.messageId} tc=${p?.toolCallId}`,
      );
    }
    if (
      typeof payloadSessionId !== "string" ||
      !this.allowedSessions.has(payloadSessionId)
    ) {
      return; // 不在当前登记集合内的 session——防串台
    }

    if (event === SESSION_WS_EVENTS.runSubagentSpawned) {
      this.allowedSessions.add(
        (payload as RunSubagentSpawnedEvent).subSessionId,
      );
    } else if (event === SESSION_WS_EVENTS.runSubagentSettled) {
      this.allowedSessions.delete(
        (payload as RunSubagentSettledEvent).subSessionId,
      );
    }

    this.seq += 1;
    const wirePayload =
      event === SESSION_WS_EVENTS.runToolCallEnd
        ? stripToolCallEndContent(payload as RunToolCallEndEvent)
        : payload;
    this.sink.onFrame({
      seq: this.seq,
      sessionId: payloadSessionId,
      event,
      payload: wirePayload,
    });

    const reason = TERMINAL_REASON_BY_EVENT.get(event);
    if (reason && payloadSessionId === this.sessionId) {
      this.sink.onTerminal?.(reason);
      if (this.stopOnTerminal) this.stop();
    }
  }
}
