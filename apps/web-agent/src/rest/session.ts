"use client";

import type {
  CreateSessionResponse,
  DeletePendingResponse,
  HistoryResponse,
  PendingResponse,
  SessionDeleteResponse,
  SessionListResponse,
  SessionSummary,
} from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";

/** appendMessage 返回的业务 payload。 */
interface AppendMessagePayload {
  messageId: string;
  queued: boolean;
}

/**
 * 创建会话。返回完整 session 对象，前端用其 unshift 进 sessionsAtom，
 * 避免再发一次 list。
 * - kind: 会话类型，默认 "user"；"quick" 表示随手问会话
 */
export async function createSession(
  content: string,
  kind?: "user" | "quick",
): Promise<CreateSessionResponse> {
  const { data } = await apiClient.post<CreateSessionResponse>(
    "/api/sessions",
    { content, kind },
  );
  return data;
}

/**
 * 获取随手问会话列表。
 */
export async function fetchQuickSessions(): Promise<SessionSummary[]> {
  const { data } = await apiClient.get<{ sessions: SessionSummary[] }>(
    "/api/sessions/quick",
  );
  return data.sessions;
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

/** 列出全部会话（已排序）。 */
export async function listSessions(): Promise<SessionSummary[]> {
  const { data } = await apiClient.get<SessionListResponse>("/api/sessions");
  return data.sessions;
}

/** 更新会话 title / pinned。 */
export async function patchSession(
  id: string,
  patch: { title?: string; pinned?: boolean },
): Promise<SessionSummary> {
  const { data } = await apiClient.patch<SessionSummary>(
    `/api/sessions/${id}`,
    patch,
  );
  return data;
}

/** 删除整条会话（级联清后端数据）。 */
export async function deleteSession(
  id: string,
): Promise<SessionDeleteResponse> {
  const { data } = await apiClient.delete<SessionDeleteResponse>(
    `/api/sessions/${id}`,
  );
  return data;
}

/** 从某条 user 消息重新生成（删后面 + 重跑）。 */
export async function regenerateMessage(
  sessionId: string,
  messageId: string,
): Promise<{ regenerated: true }> {
  const { data } = await apiClient.post<{ regenerated: true }>(
    `/api/sessions/${sessionId}/messages/${messageId}/regenerate`,
    {},
  );
  return data;
}

/** 提交 ask_question 的回答（每问题 {selected, other}，按 question 顺序）。 */
export async function confirmAnswers(
  sessionId: string,
  toolCallId: string,
  answers: { selected: string[]; other?: string }[],
): Promise<{ ok: true }> {
  const { data } = await apiClient.post<{ ok: true }>(
    `/api/sessions/${sessionId}/answer`,
    { toolCallId, answers },
  );
  return data;
}

/** 确认/取消一次待发送的 im_send_message 工具调用。 */
export async function confirmSend(
  sessionId: string,
  toolCallId: string,
  decision: "send" | "cancel",
  content?: string,
): Promise<{ ok: true }> {
  const { data } = await apiClient.post<{ ok: true }>(
    `/api/sessions/${sessionId}/confirm`,
    { toolCallId, decision, content },
  );
  return data;
}

/** 设置 assistant 消息反馈（点赞 up / 不喜欢 down / 取消 null）。 */
export async function setMessageFeedback(
  sessionId: string,
  messageId: string,
  feedback: "up" | "down" | null,
): Promise<{ feedback: "up" | "down" | null }> {
  const { data } = await apiClient.post<{ feedback: "up" | "down" | null }>(
    `/api/sessions/${sessionId}/messages/${messageId}/feedback`,
    { feedback },
  );
  return data;
}
