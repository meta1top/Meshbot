import type {
  HistoryResponse,
  PendingResponse,
  SessionSummary,
} from "@meshbot/types-agent";

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
  /** 订阅 run 事件流（连接生命周期由适配器管理）；返回退订。 */
  subscribe(events: SessionRunEvents): () => void;
}

/** AgentRunFrame 序号重排缓冲：帧可能乱序到达，按 seq 连续吐出。纯逻辑，TDD。 */
export class FrameSequencer {
  private nextExpectedSeq = 1;
  private buffer = new Map<number, { event: string; payload: unknown }>();

  /**
   * 推送一帧，返回可以立即吐出的帧序列（按 seq 连续）。
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

  /** 重置序列器状态（清空缓冲和计数器）。 */
  reset(): void {
    this.nextExpectedSeq = 1;
    this.buffer.clear();
  }
}
