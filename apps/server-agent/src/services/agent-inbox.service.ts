import { randomUUID } from "node:crypto";
import { AccountContextService } from "@meshbot/agent";
import { IM_WS_EVENTS, type ImAgentInboundEvent } from "@meshbot/types";
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { AccountRuntimeEvent } from "../account/account.events";
import { ACCOUNT_EVENTS } from "../account/account.events";
import { ImRelayClientService } from "../cloud/im-relay-client.service";
import type { ImRelayConnectedEvent } from "../cloud/im-relay.events";
import { IM_RELAY_EVENTS } from "../cloud/im-relay.events";
import { CloudImService } from "./cloud-im.service";
import { ImAgentSessionService } from "./im-agent-session.service";
import { RunnerService } from "./runner.service";
import { SessionMessageService } from "./session-message.service";
import { SessionService } from "./session.service";

/** 会话跑完但没有产出 assistant 回复时的兜底文案（导出供测试断言）。 */
export const NO_REPLY_TEXT = "(Agent 未产生回复)";

/** 补处理单会话时一次拉取的最大消息条数（MVP：不翻页，见 catchUpConversation）。 */
const CATCH_UP_PAGE_LIMIT = "50";

/**
 * 云端 → 设备 Agent 的入站消息处理：找/建本地会话 → 触发 run → 回流。
 * 仿 DispatchSubagentService；按 conversationId 串行处理（同会话的下一条
 * inbound 等前一条跑完才开始），避免同会话并发触发多个 run 相互踩踏
 * pending 消息。
 *
 * 游标分两段（Task 11 修正 T10 的真实缺口——run 成功但回流投递失败时回复
 * 永久丢失）：
 * - append 游标（`getAppended`/`advanceAppended`）：该条用户消息是否已经
 *   append 进本地 Agent 会话，防补处理重跑时 dup-append。
 * - 处理游标（`getCursor`/`advanceCursor`）：该条用户消息的回复是否已经
 *   投递成功（run 成功 + relay.send 成功，或者 run 真失败）。run 成功但
 *   relay.send 抛（未连接）时不推进处理游标，留给 catchUp 重投；append
 *   游标保证重投不会重复把用户消息塞进会话。
 *
 * 重连/启动补处理（`catchUp`）：枚举本设备全部 Agent-DM 会话，处理各自
 * 处理游标之后的 user 消息。`@OnEvent(runtimeCreated)` 与
 * `@OnEvent(connected)` 首次登录时几乎同时触发，可能并发跑两次 catchUp——
 * 靠游标幂等（第二次跑到时游标已推进，同批消息会被过滤掉）。
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
    private readonly cloudIm: CloudImService,
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

  /** 账号运行时创建（登录/重连成功建运行时）时补处理一次。 */
  @OnEvent(ACCOUNT_EVENTS.runtimeCreated)
  onRuntimeCreated(payload: AccountRuntimeEvent): void {
    void this.account.run(payload.cloudUserId, () =>
      this.catchUp(payload.cloudUserId),
    );
  }

  /** relay（IM 云连接）重连成功时补处理一次。 */
  @OnEvent(IM_RELAY_EVENTS.connected)
  onRelayConnected(payload: ImRelayConnectedEvent): void {
    void this.account.run(payload.cloudUserId, () =>
      this.catchUp(payload.cloudUserId),
    );
  }

  /**
   * 重连/启动补处理：枚举本设备全部 Agent-DM 会话，处理各自处理游标之后的
   * user 消息。枚举失败或单会话处理失败都只记日志，不影响其他会话。
   */
  private async catchUp(cloudUserId: string): Promise<void> {
    let convs: { conversationId: string; orgId: string }[];
    try {
      convs = await this.cloudIm.listAgentConversations();
    } catch (err) {
      this.logger.warn(`补处理枚举会话失败: ${String(err)}`);
      return;
    }
    for (const { conversationId } of convs) {
      await this.catchUpConversation(cloudUserId, conversationId).catch((err) =>
        this.logger.warn(`补处理会话 ${conversationId} 失败: ${String(err)}`),
      );
    }
  }

  /**
   * 单会话补处理：取处理游标 → 拉最近 50 条消息中游标之后的 user 消息 →
   * 逐条经 serialize 串行处理（与实时 inbound 共用同一把会话锁，避免双跑）。
   * MVP 不翻页：游标之后积压超过 50 条时，更早的会被忽略（已知限制）。
   */
  private async catchUpConversation(
    cloudUserId: string,
    conversationId: string,
  ): Promise<void> {
    const cursor = await this.imAgentSession.getCursor(conversationId);
    const page = await this.cloudIm.getMessages(
      conversationId,
      undefined,
      CATCH_UP_PAGE_LIMIT,
    );
    if (page.hasMore) {
      this.logger.warn(
        `会话 ${conversationId} 补处理消息超过 ${CATCH_UP_PAGE_LIMIT} 条上限，更早的消息将被忽略（已知限制）`,
      );
    }
    const fresh = page.messages
      .filter((m) => m.senderType === "user" && (!cursor || m.id > cursor))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const m of fresh) {
      await this.serialize(conversationId, () =>
        this.process(cloudUserId, {
          conversationId,
          messageId: m.id,
          content: m.content,
          senderUserId: m.senderId,
        }),
      );
    }
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
   * 找/建会话（append 段） → kickAndWait 触发 run → 取末条 assistant 回流
   * （投递段）。两段游标语义见类注释：
   * - run 失败：best-effort 回一条错误文案，无论投递是否成功都推进处理游标
   *   （避免同一条 run-崩消息无限重试）。
   * - run 成功 + relay.send 成功：推进处理游标（已投递）。
   * - run 成功 + relay.send 抛（未连接）：不推进处理游标、不改错误文案，
   *   只记日志——回复留给 catchUp 重投，append 游标保证重投不 dup-append。
   */
  private async process(
    cloudUserId: string,
    payload: ImAgentInboundEvent,
  ): Promise<void> {
    let sessionId: string;
    try {
      sessionId = await this.resolveSession(
        payload.conversationId,
        payload.messageId,
        payload.content,
      );
      await this.runner.kickAndWait(sessionId);
    } catch (err) {
      // resolveSession（找/建会话、append）或 run 本身失败：都视为"处理失败"，
      // best-effort 回一条错误文案，无论文案是否投递成功都推进处理游标——
      // 避免同一条无法处理的消息卡住整条会话反复重试。process 必须不抛出
      // （@OnEvent 处理器是 fire-and-forget，抛出会变成未捕获的 rejection）。
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
      await this.imAgentSession
        .advanceCursor(payload.conversationId, payload.messageId)
        .catch(() => undefined);
      return;
    }

    const last = await this.messages.findLastAssistant(sessionId);
    const reply = last?.content ?? NO_REPLY_TEXT;
    try {
      this.relay.send(cloudUserId, {
        conversationId: payload.conversationId,
        content: reply,
      });
    } catch (err) {
      // run 成功但投递失败（relay 断连）：不推进处理游标——回复留给 catchUp
      // 重投；append 游标（resolveSession 内）保证重投不会 dup-append。
      this.logger.warn(
        `Agent 回复已计算但未投递（conv=${payload.conversationId}）：${String(err)}，待重连补投`,
      );
      return;
    }
    await this.imAgentSession
      .advanceCursor(payload.conversationId, payload.messageId)
      .catch(() => undefined);
  }

  /**
   * 找/建会话映射 + 推进 append 游标：首次 inbound 建本地会话
   * （`kind="im-agent"`，见 `SessionService.createImAgentSession`）并落映射；
   * 非首次直接把本条内容追加到既有会话的 pending 消息。若该 messageId 已经
   * append 过（补处理重跑同一条消息），跳过 append 只取回 sessionId，防止
   * dup-append。
   */
  private async resolveSession(
    conversationId: string,
    messageId: string,
    content: string,
  ): Promise<string> {
    const existing =
      await this.imAgentSession.findByConversation(conversationId);
    if (existing) {
      const appended = await this.imAgentSession.getAppended(conversationId);
      if (appended && messageId <= appended) {
        return existing.sessionId;
      }
      await this.sessions.appendMessage(existing.sessionId, {
        messageId: randomUUID(),
        content,
      });
      await this.imAgentSession.advanceAppended(conversationId, messageId);
      return existing.sessionId;
    }
    const { sessionId } = await this.sessions.createImAgentSession(content);
    await this.imAgentSession.create(conversationId, sessionId);
    await this.imAgentSession.advanceAppended(conversationId, messageId);
    return sessionId;
  }
}
