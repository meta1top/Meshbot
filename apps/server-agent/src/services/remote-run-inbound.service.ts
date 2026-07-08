import { randomUUID } from "node:crypto";
import { AccountContextService } from "@meshbot/lib-agent";
import type { AgentRunEnd, AgentRunFrame } from "@meshbot/types";
import {
  SESSION_WS_EVENTS,
  type RunToolCallEndEvent,
} from "@meshbot/types-agent";
import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import {
  IM_RELAY_EVENTS,
  type ImRelayAgentRunRequestEvent,
} from "../cloud/im-relay.events";
import { RemoteRunRegistryService } from "./remote-run-registry.service";
import { RunnerService } from "./runner.service";
import { SessionService } from "./session.service";

/**
 * 需要转发给 A 侧的 `SESSION_WS_EVENTS.*` 全集（`session.subscribe` /
 * `unsubscribe` / `interrupt` 是客户端上行 socket 消息、`runSnapshot` 只在
 * 订阅时点对点补发，均不经 EventEmitter2 广播，转发这些名字永远收不到事件，
 * 故排除；其余 18 个由 RunnerService / ContextCompactor / DispatchSubagentService /
 * SessionTitleService 经 EventEmitter2 广播，逐个转发）。
 */
const FORWARDED_SESSION_EVENTS: readonly string[] = [
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

/** 终止事件 → `AgentRunEnd.reason` 映射；收到即回 agentRunEnd + 退订全部监听器。 */
const TERMINAL_REASON_BY_EVENT: ReadonlyMap<string, AgentRunEnd["reason"]> =
  new Map([
    [SESSION_WS_EVENTS.runDone, "done"],
    [SESSION_WS_EVENTS.runError, "error"],
    [SESSION_WS_EVENTS.runInterrupted, "interrupted"],
  ]);

/**
 * run.tool_call_end 转发前剥掉 `content` 字段（可能很大，如长文件读取结果）。
 * 与 `session.gateway.ts` 对 A 本地前端的处理保持一致——前端只用
 * `resultPreview` 渲染，`content` 没必要经 relay 跨设备中继一份，白白浪费
 * 带宽/体积。
 */
function stripToolCallEndContent(
  payload: RunToolCallEndEvent,
): Omit<RunToolCallEndEvent, "content"> {
  const { content: _content, ...rest } = payload;
  return rest;
}

/**
 * L3 B 侧：收到云端转发的远程 run 触发请求，在发起方账号的 `account.run`
 * scope 内创建/续写本地会话，`RunnerService.kick` 复用本地全套 run 逻辑
 * （零改 runner），再订阅该 sessionId 的 `SESSION_WS_EVENTS.*` 打包成
 * `AgentRunFrame` 经 relay 回发给发起设备（A）。
 *
 * 按 sessionId 精确过滤：B 上可能有多个会话/多个远程 run 并行，同一事件名
 * 会被多个请求各自的监听器收到，只有 `payload.sessionId` 命中自己登记的
 * sessionId 才转发，防止跨 run 串台。
 *
 * 终止事件（run.done/run.error/run.interrupted）触发后回发 `agentRunEnd`
 * 并逐个 `emitter.off` 移除本次登记的全部监听器，防止长连接下监听器泄漏。
 *
 * relay 传输层保持纯净：本服务经 EventEmitter2 `@OnEvent` 桥接（镜像
 * L2c `RemoteQueryInboundService`），不让 `ImRelayClientService` 反向依赖。
 *
 * 建订阅时向 `RemoteRunRegistryService` 登记 streamId→sessionId（M3 校验真源，
 * 供 `RemoteRunControlService` 校验 control 帧的 sessionId 归属），退订时一并
 * 移除登记，避免长连接下映射泄漏。
 */
@Injectable()
export class RemoteRunInboundService {
  private readonly logger = new Logger(RemoteRunInboundService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly runner: RunnerService,
    private readonly relay: ImRelayClientService,
    private readonly account: AccountContextService,
    private readonly emitter: EventEmitter2,
    private readonly registry: RemoteRunRegistryService,
  ) {}

  /** relay 收到云端转发的 agent.run.start（B 侧入站）时触发。 */
  @OnEvent(IM_RELAY_EVENTS.agentRunRequest)
  async onAgentRunRequest(evt: ImRelayAgentRunRequestEvent): Promise<void> {
    const { cloudUserId, forwarded } = evt;
    const { streamId, requesterDeviceId, mode, content } = forwarded;
    try {
      await this.account.run(cloudUserId, async () => {
        const sessionId =
          mode === "create"
            ? (await this.sessions.createSession({ content })).sessionId
            : await this.appendToExisting(forwarded.sessionId, content);
        this.subscribeAndForward(
          cloudUserId,
          streamId,
          requesterDeviceId,
          sessionId,
        );
        this.runner.kick(sessionId);
      });
    } catch (err) {
      this.logger.warn(
        `远程 run 触发失败（streamId=${streamId}）`,
        err instanceof Error ? err.stack : err,
      );
      this.relay.emitAgentRunEnd(cloudUserId, {
        streamId,
        requesterDeviceId,
        reason: "error",
      });
    }
  }

  /** append 模式：向已存在会话追加一条消息，messageId 由本地生成（远程触发无前端可代生成）。 */
  private async appendToExisting(
    sessionId: string | undefined,
    content: string,
  ): Promise<string> {
    if (!sessionId) {
      throw new Error("append 模式缺少 sessionId");
    }
    await this.sessions.appendMessage(sessionId, {
      messageId: randomUUID(),
      content,
    });
    return sessionId;
  }

  /**
   * 订阅该 sessionId 的 `SESSION_WS_EVENTS.*` 全集，按 sessionId 过滤后打包
   * 成 `AgentRunFrame` 经 relay 回发；命中终止事件则额外回发 `agentRunEnd`
   * 并退订本次登记的全部监听器。监听器就绪后向 `RemoteRunRegistryService`
   * 登记 streamId→sessionId，退订时一并解除。
   */
  private subscribeAndForward(
    cloudUserId: string,
    streamId: string,
    requesterDeviceId: string,
    sessionId: string,
  ): void {
    let seq = 0;
    const registered: Array<{
      event: string;
      handler: (payload: unknown) => void;
    }> = [];

    const unsubscribeAll = (): void => {
      for (const { event, handler } of registered) {
        this.emitter.off(event, handler);
      }
      this.registry.unbind(streamId);
    };

    for (const event of FORWARDED_SESSION_EVENTS) {
      const handler = (payload: unknown): void => {
        if ((payload as { sessionId?: unknown })?.sessionId !== sessionId) {
          return; // 别的 session 的事件——防串台
        }
        seq += 1;
        // run.tool_call_end 转发前剥掉 content（可能很大，如长文件读取结果）：
        // 照 session.gateway.ts 对 A 本地前端的处理——前端只用 resultPreview，
        // content 没必要经 relay 跨设备中继，白白浪费带宽/体积。
        const wirePayload =
          event === SESSION_WS_EVENTS.runToolCallEnd
            ? stripToolCallEndContent(payload as RunToolCallEndEvent)
            : payload;
        this.relay.emitAgentRunFrame(cloudUserId, {
          streamId,
          requesterDeviceId,
          seq,
          sessionId,
          event,
          payload: wirePayload,
        } satisfies AgentRunFrame);

        const reason = TERMINAL_REASON_BY_EVENT.get(event);
        if (reason) {
          this.relay.emitAgentRunEnd(cloudUserId, {
            streamId,
            requesterDeviceId,
            reason,
          } satisfies AgentRunEnd);
          unsubscribeAll();
        }
      };
      this.emitter.on(event, handler);
      registered.push({ event, handler });
    }

    this.registry.bind(streamId, sessionId);
  }
}
