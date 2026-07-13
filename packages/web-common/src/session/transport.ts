import type { HistoryResponse, SessionSummary } from "@meshbot/types-agent";

/** run 流事件（本机 session WS 事件与远程 AgentRunFrame 解包后的统一形态）。 */
export interface SessionRunEvents {
  /** event 名即 SESSION_WS_EVENTS 值（run.chunk/run.done/run.usage/...），payload 原样。 */
  onEvent: (event: string, payload: unknown) => void;
}

export interface StartRunInput {
  mode: "create" | "append";
  sessionId?: string;
  content: string;
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
