import { randomUUID } from "node:crypto";
import { AccountContextService } from "@meshbot/agent";
import { IM_WS_EVENTS, type ImAgentInboundEvent } from "@meshbot/types";
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import { ImAgentSessionService } from "./im-agent-session.service";
import { RunnerService } from "./runner.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";

/** 会话跑完但没有产出 assistant 回复时的兜底文案。 */
const NO_REPLY_TEXT = "(Agent 未产生回复)";

/**
 * 云端 → 设备 Agent 的入站消息处理：找/建本地会话 → 触发 run → 回流。
 * 仿 DispatchSubagentService；按 conversationId 串行处理（同会话的下一条
 * inbound 等前一条跑完才开始），避免同会话并发触发多个 run 相互踩踏
 * pending 消息。重连补处理（离线期间堆积的消息）是 Task 11，本服务只处理
 * relay 在线时的实时下行事件。
 */
@Injectable()
export class AgentInboxService {
  private readonly logger = new Logger(AgentInboxService.name);
  /** 每会话（conversationId）in-flight 串行链。 */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(
    private readonly imAgentSession: ImAgentSessionService,
    private readonly sessions: SessionService,
    private readonly runner: RunnerService,
    private readonly messages: SessionMessageService,
    private readonly relay: ImRelayClientService,
    private readonly account: AccountContextService,
  ) {}

  /**
   * relay 下行 `im.agent_inbound` 事件入口。ImRelayClientService 把下行事件的
   * `emitter.emit` 包在对应账号的 `account.run` 里，此处直接读取当前账号上下文。
   */
  @OnEvent(IM_WS_EVENTS.agentInbound)
  async handleInbound(payload: ImAgentInboundEvent): Promise<void> {
    const cloudUserId = this.account.getOrThrow();
    await this.serialize(payload.conversationId, () =>
      this.process(cloudUserId, payload),
    );
  }

  /** 按 key 串行化：同一 key 的下一次调用等前一次跑完（无论成败）才开始。 */
  private async serialize(key: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.inflight.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.inflight.set(key, next);
    try {
      await next;
    } finally {
      if (this.inflight.get(key) === next) this.inflight.delete(key);
    }
  }

  /**
   * 找/建会话 → kickAndWait 触发 run → 取末条 assistant 回流。失败时改回一条
   * 错误文案；无论成败，finally 里都推进处理游标（失败也不重放，重试留给
   * Task 11 的重连补处理）。
   */
  private async process(
    cloudUserId: string,
    payload: ImAgentInboundEvent,
  ): Promise<void> {
    try {
      const sessionId = await this.resolveSession(
        payload.conversationId,
        payload.content,
      );
      await this.runner.kickAndWait(sessionId);
      const last = await this.messages.findLastAssistant(sessionId);
      const reply = last?.content ?? NO_REPLY_TEXT;
      this.relay.send(cloudUserId, {
        conversationId: payload.conversationId,
        content: reply,
      });
    } catch (err) {
      this.logger.warn(
        `Agent 入站处理失败 conv=${payload.conversationId}: ${String(err)}`,
      );
      try {
        this.relay.send(cloudUserId, {
          conversationId: payload.conversationId,
          content: `Agent 处理失败：${err instanceof Error ? err.message : String(err)}`,
        });
      } catch {
        // relay 未连（IM_NOT_CONNECTED）：错误文案发不出去可接受，本条游标仍照常推进。
      }
    } finally {
      await this.imAgentSession
        .advanceCursor(payload.conversationId, payload.messageId)
        .catch(() => undefined);
    }
  }

  /**
   * 找/建会话映射：首次 inbound 建本地会话（`kind="im-agent"`，见
   * `SessionService.createImAgentSession`）并落映射；非首次直接把本条内容
   * 追加到既有会话的 pending 消息。
   */
  private async resolveSession(
    conversationId: string,
    content: string,
  ): Promise<string> {
    const existing =
      await this.imAgentSession.findByConversation(conversationId);
    if (existing) {
      await this.sessions.appendMessage(existing.sessionId, {
        messageId: randomUUID(),
        content,
      });
      return existing.sessionId;
    }
    const { sessionId } = await this.sessions.createImAgentSession(content);
    await this.imAgentSession.create(conversationId, sessionId);
    return sessionId;
  }
}
