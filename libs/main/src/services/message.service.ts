import type { ImMessage, MessagePage } from "@meshbot/types";
import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { type FindOptionsWhere, MoreThan, Not, type Repository } from "typeorm";

import { Message } from "../entities/message.entity";

/**
 * Message 实体的唯一归属 Service。
 * - persistMessage：单表 insert，无需 @Transactional。
 * - listMessages：游标分页（created_at DESC 查 limit+1，反转为正序返回）。
 * - unreadCount：统计 created_at > lastReadAt 的消息数；lastReadAt=null 全部。
 * - lastMessage：该会话最新一条消息。
 */
@Injectable()
export class MessageService {
  constructor(
    @InjectRepository(Message)
    private readonly msgRepo: Repository<Message>,
  ) {}

  /**
   * 持久化一条新消息，返回 ImMessage（createdAt 为 ISO 字符串）。
   * senderType 默认 'user'；设备 Agent 反向下发消息时传 'agent'。
   */
  async persistMessage(
    conversationId: string,
    senderId: string,
    content: string,
    senderType: "user" | "agent" = "user",
  ): Promise<ImMessage> {
    const entity = this.msgRepo.create({
      conversationId,
      senderId,
      content,
      senderType,
    });
    const saved = await this.msgRepo.save(entity);
    return this.toImMessage(saved);
  }

  /**
   * 历史消息游标分页。
   * - before=undefined：取最新 limit 条。
   * - before=msgId：取该消息之前（created_at <）的最近 limit 条。
   * 内部按 created_at DESC 查 limit+1 条判断 hasMore；结果反转为 ASC 返回。
   */
  async listMessages(
    conversationId: string,
    before: string | undefined,
    limit: number,
  ): Promise<MessagePage> {
    const qb = this.msgRepo
      .createQueryBuilder("m")
      .where("m.conversationId = :conversationId", { conversationId })
      .orderBy("m.createdAt", "DESC")
      .take(limit + 1);

    if (before !== undefined) {
      const cursor = await this.msgRepo.findOne({
        where: { id: before },
        select: ["createdAt"],
      });
      if (cursor) {
        qb.andWhere("m.createdAt < :ts", { ts: cursor.createdAt });
      }
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const slice = rows.slice(0, limit).reverse(); // 转为 ASC
    return { messages: slice.map((r) => this.toImMessage(r)), hasMore };
  }

  /**
   * 统计未读消息数。
   * lastReadAt=null → 全部消息数；lastReadAt=Date → 该时刻之后的消息数。
   * excludeSenderId → 排除该用户自己发的消息（自己发的不计入未读）。
   */
  async unreadCount(
    conversationId: string,
    lastReadAt: Date | null,
    excludeSenderId?: string,
  ): Promise<number> {
    const where: FindOptionsWhere<Message> = { conversationId };
    if (lastReadAt !== null) where.createdAt = MoreThan(lastReadAt);
    if (excludeSenderId) where.senderId = Not(excludeSenderId);
    return this.msgRepo.count({ where });
  }

  /** 返回该会话最新一条消息；会话为空时返回 null。 */
  async lastMessage(conversationId: string): Promise<ImMessage | null> {
    const entity = await this.msgRepo.findOne({
      where: { conversationId },
      order: { createdAt: "DESC" },
    });
    return entity ? this.toImMessage(entity) : null;
  }

  /** 内部：Message 实体 → ImMessage（createdAt 转 ISO 字符串）。 */
  private toImMessage(entity: Message): ImMessage {
    return {
      id: entity.id,
      conversationId: entity.conversationId,
      senderId: entity.senderId,
      content: entity.content,
      createdAt: entity.createdAt.toISOString(),
      senderType: entity.senderType,
    };
  }
}
