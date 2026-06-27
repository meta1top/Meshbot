import { Injectable } from "@nestjs/common";

/** 用户对一次待审批工具调用的决定。 */
export type ConfirmDecision = { action: "send" | "cancel"; content?: string };

/** waitForDecision 的结果：用户决定，或超时/中断（后两者 fail-safe，不发）。 */
export type AwaitOutcome = ConfirmDecision | "timeout" | "aborted";

/**
 * 内存确认管理：工具挂起时 waitForDecision 注册一个 deferred 并 race（超时 + abort）；
 * 前端点击经 confirm 端点 resolve 解锁。单用户本地轨，无需持久化。
 */
@Injectable()
export class ConfirmationService {
  private readonly pending = new Map<string, (d: ConfirmDecision) => void>();

  /** 确认 key：账号 + 会话 + 工具调用，三段唯一，含 cloudUserId 防跨账号解锁。 */
  static key(
    cloudUserId: string,
    sessionId: string,
    toolCallId: string,
  ): string {
    return `${cloudUserId}:${sessionId}:${toolCallId}`;
  }

  /** 注册并等待用户决定；race 超时 + abort；任一路径都清理注册项。 */
  waitForDecision(
    key: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<AwaitOutcome> {
    if (signal.aborted) {
      return Promise.resolve("aborted");
    }
    return new Promise<AwaitOutcome>((resolve) => {
      const cleanup = () => {
        this.pending.delete(key);
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve("timeout");
      }, timeoutMs);
      const onAbort = () => {
        cleanup();
        resolve("aborted");
      };
      signal.addEventListener("abort", onAbort);
      this.pending.set(key, (decision) => {
        cleanup();
        resolve(decision);
      });
    });
  }

  /** 解锁某 key 的等待（用户点发送/取消）。key 不存在 → no-op 返回 false。 */
  resolve(key: string, decision: ConfirmDecision): boolean {
    const fn = this.pending.get(key);
    if (!fn) {
      return false;
    }
    fn(decision);
    return true;
  }
}
