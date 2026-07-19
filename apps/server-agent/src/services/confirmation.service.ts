import {
  SESSION_WS_EVENTS,
  type RunHitlSettledEvent,
} from "@meshbot/types-agent";
import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";

/** 用户对一次待审批工具调用的决定（im_send 默认载荷）。 */
export type ConfirmDecision = { action: "send" | "cancel"; content?: string };

/** im_send 的 waitForDecision 结果（默认泛型下的便捷别名）。 */
export type AwaitOutcome = ConfirmDecision | "timeout" | "aborted";

/**
 * 内存确认管理（通用 HITL 挂起核心）：工具挂起时 waitForDecision 注册 deferred 并
 * race（超时 + abort）；前端经 confirm/answer 端点 resolve 解锁。decision 泛型，
 * 默认 ConfirmDecision 以兼容 im_send；ask_question 传自己的载荷。单用户本地轨，无需持久化。
 *
 * **单例命门**：`im_send_message` / `ask_question` / drive 分享类工具全部共用
 * 本服务的**同一个** DI 实例（`ImSendModule` `@Global()` 导出，唯一 provide 处）。
 * 严禁在任何其他 module 里重复 `provide ConfirmationService`——一旦分裂成两个
 * 实例，`resolve` 与 `waitForDecision` 各自挂在不同的 `pending` Map 上，
 * resolve 永远找不到对应的 pending（历史踩过的坑）。
 */
@Injectable()
export class ConfirmationService {
  private readonly pending = new Map<string, (d: unknown) => void>();

  constructor(private readonly emitter: EventEmitter2) {}

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

  /**
   * 解锁某 key 的等待。key 不存在 → no-op 返回 false（**先到先得的判定点**：
   * 首个应答返 true 并关卡，晚到的返 false，Agent 级观察通道 D3）。
   *
   * @param meta 传入则在**成功解锁时**广播一帧 `run.hitl_settled`——一次 emit
   *   同时覆盖三条出口：`SessionGateway` 转本机 ws/session 房间、
   *   `SessionFrameForwarder` 转 per-run 发起方与**全部观察者**。各端据此把
   *   卡片置为已完成，而不是让晚到方看到一个永远点不动的卡（spec §D 关卡广播）。
   *   失败时**不**广播——卡早已被首个应答关掉，重复帧只会造成 UI 抖动。
   */
  resolve<T = ConfirmDecision>(
    key: string,
    decision: T,
    meta?: {
      sessionId: string;
      toolCallId: string;
      by: "local" | "remote" | "observer";
    },
  ): boolean {
    const fn = this.pending.get(key);
    if (!fn) {
      return false;
    }
    fn(decision);
    if (meta) {
      this.emitter.emit(
        SESSION_WS_EVENTS.runHitlSettled,
        meta satisfies RunHitlSettledEvent,
      );
    }
    return true;
  }
}
