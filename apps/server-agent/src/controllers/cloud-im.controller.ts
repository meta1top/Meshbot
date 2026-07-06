import type {
  ChannelMember,
  ConversationSummary,
  DeviceView,
  MessagePage,
} from "@meshbot/types";
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
} from "@nestjs/common";

import {
  AddChannelMemberDto,
  CreateChannelDto,
  CreateDmDto,
} from "../dto/im.dto";
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

  /** 创建频道会话（支持公开/私有，可附带初始成员）。 */
  @Post("channels")
  createChannel(@Body() dto: CreateChannelDto): Promise<ConversationSummary> {
    return this.cloudIm.createChannel(dto.name, dto.visibility, dto.memberIds);
  }

  /** 向频道添加成员。 */
  @Post("channels/:id/members")
  addMember(
    @Param("id") id: string,
    @Body() dto: AddChannelMemberDto,
  ): Promise<ConversationSummary> {
    return this.cloudIm.addChannelMember(id, dto.userId);
  }

  /** 退出频道（移除当前用户）。 */
  @Delete("channels/:id/members/me")
  leave(@Param("id") id: string): Promise<{ ok: true }> {
    return this.cloudIm.leaveChannel(id);
  }

  /** 获取频道成员列表。 */
  @Get("channels/:id/members")
  listMembers(@Param("id") id: string): Promise<ChannelMember[]> {
    return this.cloudIm.listChannelMembers(id);
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

  /** 该账号云端注册设备列表（含 isCurrent 标本机）。 */
  @Get("devices")
  listDevices(): Promise<DeviceView[]> {
    return this.cloudIm.listDevices();
  }

  /** 某设备在线态。 */
  @Get("devices/:id/online")
  deviceOnline(@Param("id") id: string): Promise<{ online: boolean }> {
    return this.cloudIm.deviceOnline(id);
  }
}
