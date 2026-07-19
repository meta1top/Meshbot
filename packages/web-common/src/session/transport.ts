import type {
  HistoryResponse,
  PendingResponse,
  SessionSummary,
} from "@meshbot/types-agent";
import type { SessionListEvent } from "./session-list-events";

/** run 流事件（本机 session WS 事件与远程 AgentRunFrame 解包后的统一形态）。 */
export interface SessionRunEvents {
  /** event 名即 SESSION_WS_EVENTS 值（run.chunk/run.done/run.usage/...），payload 原样。 */
  onEvent: (event: string, payload: unknown) => void;
}

export interface StartRunInput {
  mode: "create" | "append";
  sessionId?: string;
  content: string;
  /**
   * 客户端预生成的消息 id（雪花）。本机 append 场景由调用方（hook）在乐观插入
   * user 气泡时生成，必须原样带给 startRun，使气泡 id 与后续 run.human 事件的
   * messageId 精确匹配；不传则由适配器内部生成（无法被调用方提前得知，仅用于
   * 无需匹配场景）。远程场景不使用此字段——B 侧自行生成 id。
   */
  messageId?: string;
}

/** 会话数据传输接口：hook 唯一数据入口。web-agent=本机(local+remote)；web-main=remote-only。 */
export interface SessionTransport {
  readonly capabilities: { localRun: boolean };
  listSessions(): Promise<SessionSummary[]>;
  fetchHistory(
    sessionId: string,
    opts?: { before?: string; limit?: number },
  ): Promise<HistoryResponse>;
  startRun(input: StartRunInput): Promise<{ streamId: string | null }>;
  interrupt(streamId: string | null, sessionId: string): Promise<void>;
  confirm(
    streamId: string | null,
    sessionId: string,
    toolCallId: string,
    decision: "send" | "cancel",
    content?: string,
  ): Promise<void>;
  answer(
    streamId: string | null,
    sessionId: string,
    toolCallId: string,
    answers: { selected: string[]; other?: string }[],
  ): Promise<void>;
  patchSessionModel(sessionId: string, modelConfigId: string): Promise<void>;
  /**
   * 取会话排队中的用户消息（本机专属概念：远程 relay 无「排队未处理」语义，
   * `useSessionStream` 只在 local 分支调用）。契约扩展（Task 6，从 hook 内
   * `@/rest/session` 直连迁入）——remote 侧实现应显式抛错，不伪造空结果。
   */
  fetchPending(sessionId: string): Promise<PendingResponse>;
  /**
   * 查询会话当前活跃 run 的 streamId（reclaim 场景：刷新页面 / 直接进入远程
   * 会话时用它回填 `useSessionStream` 内部的 streamId 引用，之后 confirm/
   * interrupt 才可路由到目标设备）。本机会话无独立 streamId 概念，
   * `useSessionStream` 只在 remote 分支调用。契约扩展（Task 6，从 hook 内
   * `@/rest/remote-devices` 直连迁入）——local 侧实现应显式抛错。
   */
  fetchActiveRun(sessionId: string): Promise<{ streamId: string } | null>;
  readArtifact(
    sessionId: string,
    path: string,
  ): Promise<
    | { kind: "content"; name: string; base64: string }
    | { kind: "too-large"; name: string; size: number }
  >;
  uploadArtifactToDrive(
    sessionId: string,
    path: string,
  ): Promise<{ fileId: string; name: string }>;
  /** 订阅 run 事件流（连接生命周期由适配器管理）；返回退订。
   * 允许并发多路 subscribe（如父会话视图 + N 个嵌套子代理卡共享同一
   * transport 实例）——实现方必须是多播语义，不能是「后订阅者覆盖前订阅者」
   * 的单指针（T11 报告 finding 1：单指针会导致父/子任一方永久收不到帧）。 */
  subscribe(events: SessionRunEvents): () => void;
  /**
   * 释放本 transport 实例持有的底层资源（如常驻 socket 监听器）。契约扩展
   * （T11 Task 2）——可选：远程 relay 实现（web-main）应实现，避免组件
   * remount 时监听器在 module 级单例 socket 上无界累积；本机专属实现
   * （web-agent local 分支）可不实现，无常驻监听器需要释放。消费方统一按
   * `transport.dispose?.()` 调用，缺失时安全 no-op。
   */
  dispose?: () => void;
  /**
   * 开始观察某会话的推理帧（Agent 级观察通道 · Session 级 watch，spec D5
   * 「打开会话即 session-watch」）。返回 unwatch 函数（幂等，可安全重复调用）。
   * 契约扩展（Task 12）——远程 relay 实现（web-main）用它建立 watchId 通道，
   * 中途接入靠 D7 inflight 快照续上半截输出，跨多轮 run 存活直到显式 unwatch。
   * 本机专属实现（web-agent local 分支）可为 no-op 或不实现——本机 `ws/session`
   * 本身已是实时的，不需要一条独立的观察通道。消费方统一按
   * `transport.watchSession?.(sessionId)` 调用，缺失时安全跳过。
   */
  watchSession?: (sessionId: string) => () => void;
  /**
   * 开始观察该 Agent 的会话生命周期（Agent 级观察通道，spec D9「统一事件
   * 契约」的前端接线点）。回调收到归一后的 {@link SessionListEvent}
   * （created/deleted/renamed/status_changed），非生命周期帧（推理过程帧等）
   * 已在实现层过滤掉，不会到达这里。返回 unwatch 函数（幂等，可安全重复
   * 调用）。契约扩展（Task 15 · ⭐ 交付点 B）——远程 relay 实现（web-main）
   * 用它建立与 `watchSession` 同族的 watchId 通道（scope="agent"），跨会话、
   * 跨多轮 run 存活直到显式 unwatch。本机专属实现（web-agent local 分支）
   * 要到 T19 才实现，可不实现——本机会话列表本身已经通过 `ws/events`
   * 信封实时收生命周期事件，不需要一条独立的观察通道。消费方统一按
   * `transport.watchAgent?.(cb)` 调用，缺失时安全跳过。
   */
  watchAgent?: (onEvent: (evt: SessionListEvent) => void) => () => void;
}

/**
 * run 事件多播分发器：支持任意数量并发 {@link subscribe}，每个订阅者独立
 * unsubscribe、互不影响（Set 语义）。纯逻辑（无 socket 依赖），供
 * `SessionTransport` 实现方替代「单 current 指针」的错误模式——单指针下，
 * 后订阅者会静默覆盖前订阅者的引用，导致先订阅的一方永久收不到后续帧
 * （T11 报告 finding 1：父会话视图与嵌套子代理卡共享同一 transport 实例时
 * 命中此漏洞）。
 */
export class MulticastRunEvents {
  private readonly subscribers = new Set<SessionRunEvents>();

  /** 新增一路订阅，返回退订函数（只移除本次调用登记的这一路，不影响其余）。 */
  subscribe(events: SessionRunEvents): () => void {
    this.subscribers.add(events);
    return () => {
      this.subscribers.delete(events);
    };
  }

  /** 向当前全部订阅者广播一个事件。拷贝一份快照再遍历：订阅者回调内同步
   * 退订自身不应影响本次广播的其余订阅者（同 `session-socket-adapter.ts` 的既有惯例）。 */
  emit(event: string, payload: unknown): void {
    for (const sub of [...this.subscribers]) sub.onEvent(event, payload);
  }

  /** 当前订阅者数量。 */
  get size(): number {
    return this.subscribers.size;
  }

  /** 清空全部订阅（transport dispose 时调用）。 */
  reset(): void {
    this.subscribers.clear();
  }
}

/** AgentRunFrame 序号重排缓冲：帧可能乱序到达，按 seq 连续吐出。纯逻辑，TDD。 */
export class FrameSequencer {
  private nextExpectedSeq = 1;
  private buffer = new Map<number, { event: string; payload: unknown }>();
  /** 当前是否已定基准（`primed=false` 时下一次 `push` 会用其 seq 作为起点）。 */
  private primed: boolean;
  /** 构造时记住的初值，供 `reset()` 恢复（`primeOnFirst` 模式下重置后允许重新定基准）。 */
  private readonly primedDefault: boolean;

  /**
   * @param opts.primeOnFirst 首帧的 seq 作为起始基准（**观察者通道必须开**）。
   *
   * 自己发起的 run 流总是从 seq 1 开始收，默认 false 即可。但**观察者是中途
   * 接入**——设备侧常驻转发器的 seq 从它建立那一刻起累加，观察者收到的第一
   * 帧可能是 seq 47。若仍按 1 起算，这帧会被塞进重排缓冲等一个永远不会到来的
   * seq 1，观察者一帧都吐不出来（静默失效，UI 表现为「watch 成功了但什么都
   * 不动」）。开启后首帧即定基准，之后正常按连续性重排。
   */
  constructor(opts?: { primeOnFirst?: boolean }) {
    this.primed = !opts?.primeOnFirst;
    this.primedDefault = this.primed;
  }

  /**
   * 推送一帧，返回可以立即吐出的帧序列（按 seq 连续）。
   * - 若尚未定基准（`primeOnFirst` 模式下的首帧），以本帧 seq 为起点。
   * - 若帧 seq 等于 nextExpectedSeq，立即吐出，并检查缓冲区是否可连续吐出。
   * - 若帧 seq > nextExpectedSeq，缓冲待后续填补。
   * - 若帧 seq < nextExpectedSeq，说明是重复（已吐过），丢弃。
   */
  push(frame: {
    seq: number;
    event: string;
    payload: unknown;
  }): Array<{ event: string; payload: unknown }> {
    const { seq, event, payload } = frame;

    if (!this.primed) {
      this.primed = true;
      this.nextExpectedSeq = seq;
    }

    // 丢弃重复 seq
    if (seq < this.nextExpectedSeq) {
      return [];
    }

    // 缓冲乱序帧或立即吐出
    if (seq > this.nextExpectedSeq) {
      this.buffer.set(seq, { event, payload });
      return [];
    }

    // seq === this.nextExpectedSeq，开始吐出
    const result: Array<{ event: string; payload: unknown }> = [
      { event, payload },
    ];
    this.nextExpectedSeq += 1;

    // 检查缓冲区是否可连续吐出
    while (this.buffer.has(this.nextExpectedSeq)) {
      const buffered = this.buffer.get(this.nextExpectedSeq)!;
      result.push(buffered);
      this.buffer.delete(this.nextExpectedSeq);
      this.nextExpectedSeq += 1;
    }

    return result;
  }

  /** 重置序列器状态（清空缓冲和计数器；`primeOnFirst` 模式下允许重新定基准）。 */
  reset(): void {
    this.nextExpectedSeq = 1;
    this.buffer.clear();
    this.primed = this.primedDefault;
  }
}
