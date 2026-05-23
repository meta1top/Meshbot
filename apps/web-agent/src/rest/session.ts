"use client";

import type {
  DeletePendingResponse,
  HistoryResponse,
  PendingResponse,
} from "@meshbot/types-agent";
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

/**
 * 向会话追加一条消息。`messageId` 由调用方生成（UUID）—— 让前端乐观插入 user
 * 气泡时就用最终 id，run.human 到达时能直接按 id 找到目标气泡迁出。
 */
export async function appendMessage(
  sessionId: string,
  messageId: string,
  content: string,
): Promise<AppendMessagePayload> {
  const { data } = await apiClient.post<AppendMessagePayload>(
    `/api/sessions/${sessionId}/messages`,
    { messageId, content },
  );
  return data;
}

/**
 * 取会话历史（cursor 分页）。
 * - 不传 before：拉最新一批 + inflight + sessionTotals
 * - 传 before：拉早于该 messageId 的一批；inflight 为 null、sessionTotals 不返
 */
export async function fetchHistory(
  sessionId: string,
  before?: string,
): Promise<HistoryResponse> {
  const params = new URLSearchParams();
  if (before) params.set("before", before);
  const qs = params.toString();
  const { data } = await apiClient.get<HistoryResponse>(
    `/api/sessions/${sessionId}/history${qs ? `?${qs}` : ""}`,
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

/**
 * 删除一条 pending 消息。仅 status=pending 可删。
 * 返回 content 给「编辑」场景：删完后把内容回填输入框。
 */
export async function deletePendingMessage(
  sessionId: string,
  messageId: string,
): Promise<DeletePendingResponse> {
  const { data } = await apiClient.delete<DeletePendingResponse>(
    `/api/sessions/${sessionId}/pending-messages/${messageId}`,
  );
  return data;
}
