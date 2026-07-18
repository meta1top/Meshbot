import { randomBytes } from "node:crypto";
import type {
  AgentRunControlInput,
  AgentRunEnd,
  AgentRunFrame,
} from "@meshbot/types";
import {
  SESSION_WS_EVENTS,
  type RunErrorEvent,
  type RunInterruptedEvent,
} from "@meshbot/types-agent";
import {
  ConflictException,
  Injectable,
  type OnModuleDestroy,
} from "@nestjs/common";
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import {
  REMOTE_SHADOW_FRAME_EVENT,
  type RemoteShadowFramePayload,
} from "../ws/session-shadow.events";
import { ImRelayClientService } from "./im-relay-client.service";
import { IM_RELAY_EVENTS } from "./im-relay.events";

/** streamId 长活订阅 idle 超时：超过此时长未收到新帧则视为对端失联，主动清理。 */
const IDLE_TIMEOUT_MS = 90_000;

/**
 * 远程 run 的只读视图(供 A 前端/controller 反查当前 streamId↔sessionId)。
 * @public-api Task 5 controller 消费此类型与下方 findRun* 查询方法。
 */
export type RemoteRunView = { streamId: string; sessionId: string | null };

/**
 * 单条长活流订阅：目标 agentId（守卫 (device,session) 并发用）+ B 侧会话 id
 * （create 模式首帧才知道）+ idle 超时定时器 + 是否收到过至少一帧运行帧。
 */
interface StreamEntry {
  targetAgentId: string;
  sessionId: string | null;
  timer: NodeJS.Timeout;
  /**
   * 是否已通过 `onFrame` 收到过至少一帧真实运行帧（Bug #13 命门）。
   * B 侧二次门控等「预检拒绝」（`agent_not_remotable`/未建会话即失联的
   * `offline`）发生在任何 `SESSION_WS_EVENTS.*` 帧产生之前——`onEnd`
   * 据此判断是否需要主动补发一条影子 `run.error` 收尾，否则前端永远等
   * 不到 done/interrupted/error，`running` 卡死、用户消息也没有落地机会。
   * 正常终止（done/error/interrupted）在 `agentRunEnd` 之前，B 侧
   * `subscribeAndForward` 已经把真实的终止帧转发过一次，此时该值必为
   * true，`onEnd` 不需要也不应该再补发。
   */
  frameReceived: boolean;
}

/**
 * 把「预检拒绝」的 `AgentRunEnd.reason` 映射成默认展示文案（未接入 next-intl
 * 的消费方——如 web-main 独立实现——的兜底；web-agent 前端优先用
 * `RunErrorEvent.reason` 走专属 next-intl 文案，见
 * `packages/web-common/src/session/use-session-stream.ts` 的 onError）。
 */
function describePreflightRejection(reason: AgentRunEnd["reason"]): string {
  switch (reason) {
    case "agent_not_remotable":
      return "目标 Agent 不可远程访问（不存在或未开启远程），本次消息未发送";
    case "session_agent_mismatch":
      return "该会话不属于所选 Agent，本次消息未发送";
    case "offline":
      return "目标设备已离线，本次消息未发送";
    default:
      return `远程 run 未能开始（${reason}）`;
  }
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
 * （含 sessionId），本服务把它包进 `REMOTE_SHADOW_FRAME_EVENT` 重发到本地
 * EventEmitter2 总线（**不**复用原始 SESSION_WS_EVENTS.* 名——那条总线上还有
 * `RunnerService` 等按事件名订阅的本地落库副作用，复用会把 B 会话的数据污染
 * 进 A 本地 SQLite，见该常量的 JSDoc），A 的 `SessionGateway`
 * （`@OnEvent(REMOTE_SHADOW_FRAME_EVENT)`）解包后按 payload.sessionId 转发到
 * 对应 room——A 前端订阅该 sessionId 即像看本地 run 一样收到远程设备的流式输出。
 *
 * 并发守卫（Phase A 最简）：同一 (targetAgentId, sessionId) 只允许一个活跃的
 * append 续写 run；重复发起直接拒绝（409），不做 B 侧按 streamId 的排队/挂起
 * （那是 Phase B 范围）。避免同 session 两套 B 侧监听器并行导致帧翻倍、
 * 第一条 run.done 提前退订两套监听器、第二条对 A 不可见。
 *
 * 命名（计划二 2c）：`targetAgentId` 形参/字段/守卫键的值即云端 agent.id，
 * 就地传给 relay 的 `targetAgentId` 协议字段；调用方（RemoteAgentSessionController）
 * 传入的路径参数 `:agentId` 已是云端 agentId，网关 `findActiveById` 据此寻址。
 */
@Injectable()
export class RemoteRunService implements OnModuleDestroy {
  private readonly streams = new Map<string, StreamEntry>();
  /** (targetAgentId, sessionId) → 占用该槽位的 streamId，append 并发守卫用。 */
  private readonly activeSessionRuns = new Map<string, string>();

  constructor(
    private readonly relay: ImRelayClientService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * 发起对目标设备的远程 run：生成 streamId、登记长活订阅，经 relay 下发到
   * 目标设备（B）。
   *
   * append 模式下若目标 (targetAgentId, sessionId) 已有活跃 run（尚未收到
   * done/error/interrupted/offline 或 idle 超时）→ 抛 409，拒绝并发第二个远程
   * run；本地会话（不经本服务）不受影响。
   *
   * @param cloudUserId   发起账号
   * @param targetAgentId 目标云端 Agent ID
   * @param mode          create：B 新建会话（sessionId 传 null，经首帧回报）；
   *                      append：续写 B 上已存在的会话（sessionId 为该会话 id）
   * @param sessionId     append 模式下 B 侧会话 id；create 模式传 null
   * @param content       本轮用户输入
   */
  startRun(
    cloudUserId: string,
    targetAgentId: string,
    mode: "create" | "append",
    sessionId: string | null,
    content: string,
  ): { streamId: string } {
    if (mode === "append" && sessionId) {
      const key = RemoteRunService.sessionKey(targetAgentId, sessionId);
      if (this.activeSessionRuns.has(key)) {
        throw new ConflictException(
          `远程会话 ${sessionId} 已有进行中的 run，请等待完成后再发送`,
        );
      }
    }
    const streamId = randomBytes(16).toString("hex");
    this.register(streamId, targetAgentId, sessionId);
    try {
      this.relay.emitAgentRunStart(cloudUserId, {
        streamId,
        targetAgentId,
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
   * 重发到本地桥事件 `REMOTE_SHADOW_FRAME_EVENT`；未知 streamId（已清理 /
   * 已超时）→ 忽略。
   */
  @OnEvent(IM_RELAY_EVENTS.agentRunFrame)
  onFrame(frame: AgentRunFrame): void {
    // 本服务只跟踪自己发起的 streamId 订阅（Agent 级观察通道的 watchId 寻址
    // 帧留给后续 Task 消费，此处尚未登记任何 watchId，直接忽略）。
    if (!frame.streamId) return;
    const entry = this.streams.get(frame.streamId);
    if (!entry) return;
    if (!entry.sessionId && frame.sessionId) {
      // create 模式：首帧起记住 B 的会话 id，并占用并发守卫槽位。
      entry.sessionId = frame.sessionId;
      this.activeSessionRuns.set(
        RemoteRunService.sessionKey(entry.targetAgentId, frame.sessionId),
        frame.streamId,
      );
    }
    this.bumpIdle(frame.streamId);
    entry.frameReceived = true;
    // 影子渲染：frame.payload 已是完整 SESSION_WS_EVENTS.* payload，包进专属
    // 桥事件重发，A 的 SessionGateway 解包后转发到 room=payload.sessionId。
    this.emitter.emit(REMOTE_SHADOW_FRAME_EVENT, {
      event: frame.event,
      payload: frame.payload,
    } satisfies RemoteShadowFramePayload);
  }

  /**
   * relay 收到 B 侧流终止通知（done/error/interrupted/offline/agent_not_remotable）
   * → 清理该 streamId 订阅。
   *
   * 【Bug #13 命门】正常终止（done/error/interrupted）之前，B 侧
   * `subscribeAndForward` 已经把真实的 `SESSION_WS_EVENTS.*` 终止帧转发过一次
   * （`onFrame` 收到、`entry.frameReceived` 已置 true），前端早已据此清过
   * `running`。但二次门控等「预检拒绝」（`agent_not_remotable`）发生在 B 侧
   * 建会话 / 转发任何帧之前——本 streamId 从未走过 `onFrame`，前端对这次
   * 远程 run 一无所知：`running` 永远卡 true（打断按钮不消失）、也永远等
   * 不到 `run.human`（用户发的消息从未在 timeline 出现过）。这里补一条影子
   * `run.error`（带 `reason`，供前端走专属文案 + 补一条失败气泡），是这条
   * streamId 唯一能触达前端的机会——`entry.sessionId` 为 null（create 模式
   * 首帧都没到达）时没有房间可发，只能静默清理（与 idle 超时兜底同一取舍）。
   */
  @OnEvent(IM_RELAY_EVENTS.agentRunEnd)
  onEnd(end: AgentRunEnd): void {
    const entry = this.streams.get(end.streamId);
    if (entry && !entry.frameReceived && entry.sessionId) {
      if (end.reason === "interrupted") {
        // 用户主动打断，且打断赶在任何帧回流之前（append 模式常见）。这不是
        // 「预检拒绝」，补 run.error 会让用户看到 describePreflightRejection 的
        // 兜底文案「远程 run 未能开始（interrupted）」——把自己按的停止说成失败。
        // 补一条影子 run.interrupted：同样能清 running（前端 onInterrupted），
        // 但走的是「已停止」语义，不弹错误气泡。messageId 用空串——本轮从未有
        // 帧回流，没有任何一条消息可指名，前端 settleInterruptedTimeline 按
        // messageId 精确匹配不中即退化为不改任何气泡，正是期望行为。
        this.emitter.emit(REMOTE_SHADOW_FRAME_EVENT, {
          event: SESSION_WS_EVENTS.runInterrupted,
          payload: {
            sessionId: entry.sessionId,
            messageId: "",
          } satisfies RunInterruptedEvent,
        } satisfies RemoteShadowFramePayload);
      } else {
        this.emitter.emit(REMOTE_SHADOW_FRAME_EVENT, {
          event: SESSION_WS_EVENTS.runError,
          payload: {
            sessionId: entry.sessionId,
            messageId: null,
            pendingIds: [],
            error: describePreflightRejection(end.reason),
            reason: end.reason,
          } satisfies RunErrorEvent,
        } satisfies RemoteShadowFramePayload);
      }
    }
    this.clear(end.streamId);
  }

  /** 模块销毁时清理全部长活订阅的定时器，防泄漏。 */
  onModuleDestroy(): void {
    for (const streamId of [...this.streams.keys()]) {
      this.clear(streamId);
    }
  }

  /** (targetAgentId, sessionId) 并发守卫的 Map key（协议改名对齐，见类注释）。 */
  private static sessionKey(targetAgentId: string, sessionId: string): string {
    return `${targetAgentId}::${sessionId}`;
  }

  /** 登记 streamId 长活订阅并启动 idle 超时定时器；append 模式立即占用并发守卫槽位。 */
  private register(
    streamId: string,
    targetAgentId: string,
    sessionId: string | null,
  ): void {
    this.streams.set(streamId, {
      targetAgentId,
      sessionId,
      timer: this.scheduleIdleTimeout(streamId),
      frameReceived: false,
    });
    if (sessionId) {
      this.activeSessionRuns.set(
        RemoteRunService.sessionKey(targetAgentId, sessionId),
        streamId,
      );
    }
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
      this.releaseSlot(streamId, entry);
      if (entry?.sessionId) {
        this.emitter.emit(REMOTE_SHADOW_FRAME_EVENT, {
          event: SESSION_WS_EVENTS.runError,
          payload: {
            sessionId: entry.sessionId,
            messageId: null,
            pendingIds: [],
            error: "remote run idle timeout",
          } satisfies RunErrorEvent,
        } satisfies RemoteShadowFramePayload);
      }
    }, IDLE_TIMEOUT_MS);
    timer.unref?.();
    return timer;
  }

  /** 清理指定 streamId 的登记项（含定时器 + 并发守卫槽位），防泄漏。 */
  private clear(streamId: string): void {
    const entry = this.streams.get(streamId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.releaseSlot(streamId, entry);
  }

  /**
   * 从 `streams` 与 `activeSessionRuns` 两个 Map 释放指定 streamId 的登记项。
   * activeSessionRuns 按 key 比对 streamId 后才删除——防止旧 streamId 的迟到
   * 清理误删已被新 run 重新占用的同一 key。
   */
  private releaseSlot(streamId: string, entry: StreamEntry | undefined): void {
    this.streams.delete(streamId);
    if (!entry?.sessionId) return;
    const key = RemoteRunService.sessionKey(
      entry.targetAgentId,
      entry.sessionId,
    );
    if (this.activeSessionRuns.get(key) === streamId) {
      this.activeSessionRuns.delete(key);
    }
  }

  /**
   * 按 streamId 查活跃远程 run;未找到返 null。
   * @public-api Task 5 controller 消费此类型与下方 findRun* 查询方法。
   */
  findRunByStreamId(streamId: string): RemoteRunView | null {
    const entry = this.streams.get(streamId);
    return entry ? { streamId, sessionId: entry.sessionId } : null;
  }

  /**
   * 按 (targetAgentId, sessionId) 反查活跃远程 run 的 streamId;未找到返 null。
   * 用于刷新/直接进入正在跑的远程会话时,前端补齐 streamId 以路由 confirm/interrupt。
   * @public-api Task 5 controller 消费此类型与下方 findRun* 查询方法。
   */
  findRunBySession(
    targetAgentId: string,
    sessionId: string,
  ): RemoteRunView | null {
    const streamId = this.activeSessionRuns.get(
      RemoteRunService.sessionKey(targetAgentId, sessionId),
    );
    if (!streamId) return null;
    const entry = this.streams.get(streamId);
    return entry ? { streamId, sessionId: entry.sessionId } : null;
  }
}
