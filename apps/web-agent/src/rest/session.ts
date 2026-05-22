"use client";

import type { HistoryResponse, PendingResponse } from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";

/** appendMessage 返回的业务 payload。 */
interface AppendMessagePayload {
  messageId: string;
  queued: boolean;
}

/** 创建会话，返回 sessionId。 */
export async function createSession(content: string): Promise<string> {
  const { data } = await apiClient.post<{ sessionId: string }>(
    "/api/sessions",
    { content },
  );
  return data.sessionId;
}

/** 向会话追加一条消息。 */
export async function appendMessage(
  sessionId: string,
  content: string,
): Promise<AppendMessagePayload> {
  const { data } = await apiClient.post<AppendMessagePayload>(
    `/api/sessions/${sessionId}/messages`,
    { content },
  );
  return data;
}

/** 取会话已处理历史 + inflight。 */
export async function fetchHistory(
  sessionId: string,
): Promise<HistoryResponse> {
  const { data } = await apiClient.get<HistoryResponse>(
    `/api/sessions/${sessionId}/history`,
  );
  return data;
}

/** 取会话排队中的用户消息。 */
export async function fetchPending(
  sessionId: string,
): Promise<PendingResponse> {
  const { data } = await apiClient.get<PendingResponse>(
    `/api/sessions/${sessionId}/pending`,
  );
  return data;
}

/** 重试会话失败消息。 */
export async function retrySession(
  sessionId: string,
): Promise<{ retried: boolean }> {
  const { data } = await apiClient.post<{ retried: boolean }>(
    `/api/sessions/${sessionId}/retry`,
    {},
  );
  return data;
}
