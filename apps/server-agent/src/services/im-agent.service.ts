import { AccountContextService } from "@meshbot/agent";
import { IM_WS_EVENTS, type ImMessage } from "@meshbot/types";
import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import { CloudIdentityService } from "./cloud-identity.service";
import { CloudImService } from "./cloud-im.service";
import { RunnerService } from "./runner.service";
import { SessionService } from "./session.service";
import { shouldTriggerCompanion } from "./im-agent.trigger";

/**
 * IM 伴生 Agent 编排：监听入站 IM 消息，把消息摄入对应会话的伴生 Agent 会话，
 * 按"私信对端 / 频道@自己 + 开关"触发本地 Agent 运行（候选回复进伴生会话，不发 IM）。
 * 运行在 relay 注入的账号上下文内（relay 用 account.run 包裹 emit）。
 *
 * 摄入用 pending 队列累积上下文；非触发消息只 append 不 kick，下次触发 kick 时
 * runner 一并 claim 处理（批量上下文）。开关关时跳过摄入（避免 pending 永不消费堆积）。
 */
@Injectable()
export class ImAgentService {
  private readonly logger = new Logger(ImAgentService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly runner: RunnerService,
    private readonly cloudIm: CloudImService,
    private readonly identity: CloudIdentityService,
    private readonly account: AccountContextService,
  ) {}

  /** 入站 IM 消息钩子（relay → EventEmitter2，账号上下文内同步派发）。 */
  @OnEvent(IM_WS_EVENTS.message)
  async onImMessage(msg: ImMessage): Promise<void> {
    try {
      const selfId = this.account.get();
      if (!selfId) return;

      const convs = await this.cloudIm.listConversations();
      const conv = convs.find((c) => c.id === msg.conversationId);
      if (!conv || (conv.type !== "channel" && conv.type !== "dm")) return;
      const title = conv.name ?? conv.peer?.displayName ?? "IM 会话";

      const companion = await this.sessions.findOrCreateImCompanion(
        msg.conversationId,
        conv.type,
        title,
      );

      if (!companion.agentEnabled) return;

      const self = await this.identity.get(selfId);
      const who = msg.senderId === selfId ? "我" : "对端";
      await this.sessions.appendMessage(companion.id, {
        messageId: msg.id,
        content: `[${who}] ${msg.content}`,
      });

      const selfHandles = self
        ? [self.displayName, self.email.split("@")[0]].filter(Boolean)
        : [];
      const trigger = shouldTriggerCompanion({
        convType: companion.imConvType ?? conv.type,
        senderId: msg.senderId,
        selfId,
        content: msg.content,
        selfHandles,
        agentEnabled: companion.agentEnabled,
      });
      if (trigger) {
        this.runner.kick(companion.id);
      }
    } catch (err) {
      this.logger.error(
        `IM 伴生 Agent 处理入站消息失败 conv=${msg.conversationId} msg=${msg.id}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
