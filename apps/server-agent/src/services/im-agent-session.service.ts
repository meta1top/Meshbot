import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ScopedRepository } from "../account/scoped-repository";
import { ScopedRepositoryFactory } from "../account/scoped-repository.factory";
import { ImAgentSession } from "../entities/im-agent-session.entity";

/** ImAgentSession 表的归属 Service —— IM Agent 会话映射与处理游标的数据层（按账号隔离）。 */
@Injectable()
export class ImAgentSessionService {
  /** ImAgentSession 账号作用域仓库（自动按当前账号过滤/盖章）。 */
  private readonly repo: ScopedRepository<ImAgentSession>;

  constructor(
    @InjectRepository(ImAgentSession)
    private readonly rawRepo: Repository<ImAgentSession>,
    scopedFactory: ScopedRepositoryFactory,
  ) {
    this.repo = scopedFactory.create(rawRepo);
  }

  /**
   * 查会话映射（当前账号）。
   *
   * @param conversationId - 云端对话 ID
   * @returns 匹配的会话映射，或 null 如果不存在
   */
  findByConversation(conversationId: string): Promise<ImAgentSession | null> {
    return this.repo.findOne({ where: { conversationId } });
  }

  /**
   * 建映射（盖当前账号）。
   *
   * @param conversationId - 云端对话 ID
   * @param sessionId - 本地 Agent 会话 ID
   * @returns 新创建的会话映射记录
   */
  async create(
    conversationId: string,
    sessionId: string,
  ): Promise<ImAgentSession> {
    return this.repo.save({
      conversationId,
      sessionId,
    }) as Promise<ImAgentSession>;
  }

  /**
   * 推进处理游标。
   *
   * @param conversationId - 云端对话 ID
   * @param messageId - 最后处理的消息 ID
   */
  async advanceCursor(
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    await this.repo.update(
      { conversationId },
      { lastProcessedMessageId: messageId },
    );
  }

  /**
   * 取处理游标。
   *
   * @param conversationId - 云端对话 ID
   * @returns 最后处理的消息 ID，或 null 如果未设置
   */
  async getCursor(conversationId: string): Promise<string | null> {
    const row = await this.repo.findOne({ where: { conversationId } });
    return row?.lastProcessedMessageId ?? null;
  }

  /**
   * 推进 append 游标（该条用户消息已 append 进本地 Agent 会话）。
   *
   * @param conversationId - 云端对话 ID
   * @param messageId - 已 append 的消息 ID
   */
  async advanceAppended(
    conversationId: string,
    messageId: string,
  ): Promise<void> {
    await this.repo.update(
      { conversationId },
      { lastAppendedMessageId: messageId },
    );
  }

  /**
   * 取 append 游标。
   *
   * @param conversationId - 云端对话 ID
   * @returns 最后 append 的消息 ID，或 null 如果未设置
   */
  async getAppended(conversationId: string): Promise<string | null> {
    const row = await this.repo.findOne({ where: { conversationId } });
    return row?.lastAppendedMessageId ?? null;
  }
}
