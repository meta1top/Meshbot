import type { ConversationSummary, MessagePage } from "@meshbot/types";
import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";

import { CreateChannelDto, CreateDmDto } from "../dto/im.dto";
import { CloudImService } from "../services/cloud-im.service";

/**
 * 云端 IM REST 端点的本地薄代理（方案 A）。全部受本地 JWT 保护。
 * 委托 CloudImService 处理 token 取用与云端调用。
 */
@Controller("api")
export class CloudImController {
  constructor(private readonly cloudIm: CloudImService) {}

  /** 当前用户的会话列表。 */
  @Get("conversations")
  listConversations(): Promise<ConversationSummary[]> {
    return this.cloudIm.listConversations();
  }

  /** 创建频道会话。 */
  @Post("channels")
  createChannel(@Body() dto: CreateChannelDto): Promise<ConversationSummary> {
    return this.cloudIm.createChannel(dto.name);
  }

  /** 创建私信会话。 */
  @Post("dms")
  createDm(@Body() dto: CreateDmDto): Promise<ConversationSummary> {
    return this.cloudIm.createDm(dto.userId);
  }

  /** 获取会话历史消息（支持 before / limit 分页）。 */
  @Get("conversations/:id/messages")
  getMessages(
    @Param("id") id: string,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
  ): Promise<MessagePage> {
    return this.cloudIm.getMessages(id, before, limit);
  }
}
