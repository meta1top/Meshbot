"use client";

import type { ConversationSummary, MessagePage } from "@meshbot/types";
import { apiClient } from "@meshbot/web-common";

/**
 * 获取当前用户的所有会话（频道 + DM）。
 */
export async function fetchConversations(): Promise<ConversationSummary[]> {
  const { data } =
    await apiClient.get<ConversationSummary[]>("/api/conversations");
  return data;
}

/**
 * 创建频道。返回新会话摘要。
 */
export async function createChannel(
  name: string,
): Promise<ConversationSummary> {
  const { data } = await apiClient.post<ConversationSummary>("/api/channels", {
    name,
  });
  return data;
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
