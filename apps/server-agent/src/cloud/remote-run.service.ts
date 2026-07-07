import { randomBytes } from "node:crypto";
import type {
  AgentRunControlInput,
  AgentRunEnd,
  AgentRunFrame,
} from "@meshbot/types";
import { SESSION_WS_EVENTS, type RunErrorEvent } from "@meshbot/types-agent";
import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import { ImRelayClientService } from "./im-relay-client.service";
import { IM_RELAY_EVENTS } from "./im-relay.events";

/** streamId 长活订阅 idle 超时：超过此时长未收到新帧则视为对端失联，主动清理。 */
const IDLE_TIMEOUT_MS = 90_000;

/** 单条长活流订阅：B 侧会话 id（create 模式首帧才知道）+ idle 超时定时器。 */
interface StreamEntry {
  sessionId: string | null;
  timer: NodeJS.Timeout;
}

/**
 * L3 A 侧：发起跨设备远程 run + 影子渲染（streamId 长活订阅，镜像
 * `RemoteDeviceQueryService` 的 pending-map 范式，但改为长活多帧——不是收一帧
 * 就 delete，而是持续中继直到 `agentRunEnd` 或 idle 超时）。
 *
 * relay 传输层保持纯净：本服务经 EventEmitter2 `@OnEvent` 订阅 B 侧回流的
 * 运行帧 / 流终止事件，不让 ImRelayClientService 反向依赖本服务（避免循环依赖）。
 *
 * 影子渲染：`agentRunFrame` 的 payload 已是完整的 `SESSION_WS_EVENTS.*` 载荷
 * （含 sessionId），本服务把它原样重发到本地 EventEmitter2 总线，A 的
 * `SessionGateway`（`@OnEvent(SESSION_WS_EVENTS.*)`）照常转发到对应 room——
 * A 前端订阅该 sessionId 即像看本地 run 一样收到远程设备的流式输出。
 */
@Injectable()
export class RemoteRunService implements OnModuleDestroy {
  private readonly streams = new Map<string, StreamEntry>();

  constructor(
    private readonly relay: ImRelayClientService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * 发起对目标设备的远程 run：生成 streamId、登记长活订阅，经 relay 下发到
   * 目标设备（B）。
   *
   * @param cloudUserId    发起账号
   * @param targetDeviceId 目标设备 ID
   * @param mode           create：B 新建会话（sessionId 传 null，经首帧回报）；
   *                       append：续写 B 上已存在的会话（sessionId 为该会话 id）
   * @param sessionId      append 模式下 B 侧会话 id；create 模式传 null
   * @param content        本轮用户输入
   */
  startRun(
    cloudUserId: string,
    targetDeviceId: string,
    mode: "create" | "append",
    sessionId: string | null,
    content: string,
  ): { streamId: string } {
    const streamId = randomBytes(16).toString("hex");
    this.register(streamId, sessionId);
    try {
      this.relay.emitAgentRunStart(cloudUserId, {
        streamId,
        targetDeviceId,
        mode,
        sessionId: sessionId ?? undefined,
        content,
      });
    } catch (e) {
      this.clear(streamId);
      throw e;
    }
    return { streamId };
  }

  /** 下发运行中控制指令（confirm / answer / interrupt），不等待响应。 */
  sendControl(cloudUserId: string, control: AgentRunControlInput): void {
    this.relay.emitAgentRunControl(cloudUserId, control);
  }

  /**
   * relay 收到 B 侧回流的运行帧：若 streamId 已登记 → 续期 idle 超时 + 影子
   * 重发到本地 SESSION_WS_EVENTS 总线；未知 streamId（已清理 / 已超时）→ 忽略。
   */
  @OnEvent(IM_RELAY_EVENTS.agentRunFrame)
  onFrame(frame: AgentRunFrame): void {
    const entry = this.streams.get(frame.streamId);
    if (!entry) return;
    entry.sessionId = frame.sessionId; // create 模式：首帧起记住 B 的会话 id
    this.bumpIdle(frame.streamId);
    // 影子渲染：frame.payload 已是完整 SESSION_WS_EVENTS.* payload，直接重发即可，
    // A 的 SessionGateway 会照常转发到 room=payload.sessionId（该 Gateway 零改）。
    this.emitter.emit(frame.event, frame.payload);
  }

  /** relay 收到 B 侧流终止通知（done/error/interrupted/offline）→ 清理该 streamId 订阅。 */
  @OnEvent(IM_RELAY_EVENTS.agentRunEnd)
  onEnd(end: AgentRunEnd): void {
    this.clear(end.streamId);
  }

  /** 模块销毁时清理全部长活订阅的定时器，防泄漏。 */
  onModuleDestroy(): void {
    for (const streamId of [...this.streams.keys()]) {
      this.clear(streamId);
    }
  }

  /** 登记 streamId 长活订阅并启动 idle 超时定时器。 */
  private register(streamId: string, sessionId: string | null): void {
    this.streams.set(streamId, {
      sessionId,
      timer: this.scheduleIdleTimeout(streamId),
    });
  }

  /** 续期 idle 超时（收到新帧即重置倒计时）。 */
  private bumpIdle(streamId: string): void {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = this.scheduleIdleTimeout(streamId);
  }

  /**
   * idle 超时到期：清理订阅；若已知 B 侧 sessionId（至少收到过一帧），向 A 前端
   * 发 `run.error` 收尾提示，避免界面永远停在「运行中」。create 模式下若首帧
   * 从未到达（sessionId 仍为 null，无房间可通知）→ 静默清理。
   */
  private scheduleIdleTimeout(streamId: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const entry = this.streams.get(streamId);
      this.streams.delete(streamId);
      if (entry?.sessionId) {
        this.emitter.emit(SESSION_WS_EVENTS.runError, {
          sessionId: entry.sessionId,
          messageId: null,
          pendingIds: [],
          error: "remote run idle timeout",
        } satisfies RunErrorEvent);
      }
    }, IDLE_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  /** 清理指定 streamId 的登记项（含定时器），防泄漏。 */
  private clear(streamId: string): void {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.streams.delete(streamId);
  }
}
