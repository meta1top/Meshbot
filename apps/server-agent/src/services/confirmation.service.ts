import { Injectable } from "@nestjs/common";

/** 用户对一次待审批工具调用的决定（im_send 默认载荷）。 */
export type ConfirmDecision = { action: "send" | "cancel"; content?: string };

/** im_send 的 waitForDecision 结果（默认泛型下的便捷别名）。 */
export type AwaitOutcome = ConfirmDecision | "timeout" | "aborted";

/**
 * 内存确认管理（通用 HITL 挂起核心）：工具挂起时 waitForDecision 注册 deferred 并
 * race（超时 + abort）；前端经 confirm/answer 端点 resolve 解锁。decision 泛型，
 * 默认 ConfirmDecision 以兼容 im_send；ask_question 传自己的载荷。单用户本地轨，无需持久化。
 */
@Injectable()
export class ConfirmationService {
  private readonly pending = new Map<string, (d: unknown) => void>();

  /** 确认 key：账号 + 会话 + 工具调用，三段唯一，含 cloudUserId 防跨账号解锁。 */
  static key(
    cloudUserId: string,
    sessionId: string,
    toolCallId: string,
  ): string {
    return `${cloudUserId}:${sessionId}:${toolCallId}`;
  }

  /** 注册并等待用户决定；race 超时 + abort；任一路径都清理注册项。 */
  waitForDecision<T = ConfirmDecision>(
    key: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<T | "timeout" | "aborted"> {
    if (signal.aborted) {
      return Promise.resolve("aborted");
    }
    return new Promise<T | "timeout" | "aborted">((resolve) => {
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
        resolve(decision as T);
      });
    });
  }

  /** 解锁某 key 的等待。key 不存在 → no-op 返回 false。 */
  resolve<T = ConfirmDecision>(key: string, decision: T): boolean {
    const fn = this.pending.get(key);
    if (!fn) {
      return false;
    }
    fn(decision);
    return true;
  }
}
