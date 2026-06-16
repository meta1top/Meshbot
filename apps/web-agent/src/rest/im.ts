"use client";

import type {
  ChannelMember,
  ConversationSummary,
  MessagePage,
} from "@meshbot/types";
import { apiClient } from "@meshbot/web-common";

/**
 * 获取当前用户的所有会话（频道 + DM）。
 */
export async function fetchConversations(): Promise<ConversationSummary[]> {
  const { data } =
    await apiClient.get<ConversationSummary[]>("/api/conversations");
  // 未登录云端时后端返回 401 错误 envelope，解包后 data 可能为 null/undefined；
  // 兜底成空数组以遵守 Promise<ConversationSummary[]> 契约，避免下游 [...arr] 崩溃。
  return Array.isArray(data) ? data : [];
}

/**
 * 创建频道。visibility 默认 public；private 时可带初始成员。返回新会话摘要。
 */
export async function createChannel(
  name: string,
  visibility: "public" | "private" = "public",
  memberIds?: string[],
): Promise<ConversationSummary> {
  const { data } = await apiClient.post<ConversationSummary>("/api/channels", {
    name,
    visibility,
    memberIds,
  });
  return data;
}

/** 把组织成员拉入私有频道。 */
export async function addChannelMember(
  conversationId: string,
  userId: string,
): Promise<ConversationSummary> {
  const { data } = await apiClient.post<ConversationSummary>(
    `/api/channels/${conversationId}/members`,
    { userId },
  );
  return data;
}

/** 退出私有频道（自身）。 */
export async function leaveChannel(conversationId: string): Promise<void> {
  await apiClient.delete(`/api/channels/${conversationId}/members/me`);
}

/** 私有频道成员列表。 */
export async function listChannelMembers(
  conversationId: string,
): Promise<ChannelMember[]> {
  const { data } = await apiClient.get<ChannelMember[]>(
    `/api/channels/${conversationId}/members`,
  );
  return Array.isArray(data) ? data : [];
}

/**
 * 创建与指定用户的 DM 会话。返回新会话摘要（已存在则返回现有）。
 */
export async function createDm(userId: string): Promise<ConversationSummary> {
  const { data } = await apiClient.post<ConversationSummary>("/api/dms", {
    userId,
  });
  return data;
}

/**
 * 分页拉取会话消息（cursor 分页）。
 * - 不传 before：拉最新一批
 * - 传 before：拉早于该 messageId 的一批
 */
export async function fetchMessages(
  conversationId: string,
  before?: string,
): Promise<MessagePage> {
  const params = new URLSearchParams();
  if (before) params.set("before", before);
  const qs = params.toString();
  const { data } = await apiClient.get<MessagePage>(
    `/api/conversations/${conversationId}/messages${qs ? `?${qs}` : ""}`,
  );
  return data;
}
