import type { HistoryResponse, PendingResponse } from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";

/** 后端成功响应 envelope（ResponseInterceptor 包装）。 */
interface SuccessEnvelope<T> {
  success: boolean;
  code: number;
  data: T;
}

/**
 * 从 axios 响应体取实际 payload。
 *
 * server-agent 全局 ResponseInterceptor 把成功响应包成
 * `{ success, code, data, ... }`。这里识别该 envelope 并取出 `data`；
 * 若响应未被包装（如 @SkipResponseEnvelope 路由或测试环境）则原样返回。
 */
function unwrap<T>(body: T | SuccessEnvelope<T>): T {
  if (
    body !== null &&
    typeof body === "object" &&
    "success" in body &&
    "data" in body
  ) {
    return (body as SuccessEnvelope<T>).data;
  }
  return body as T;
}

/** 创建会话，返回 sessionId。 */
export async function createSession(content: string): Promise<string> {
  const { data } = await apiClient.post<
    SuccessEnvelope<{ sessionId: string }> | { sessionId: string }
  >("/api/sessions", { content });
  return unwrap(data).sessionId;
}

/** 向会话追加一条消息。 */
export async function appendMessage(
  sessionId: string,
  content: string,
): Promise<{ messageId: string; queued: boolean }> {
  type Payload = { messageId: string; queued: boolean };
  const { data } = await apiClient.post<SuccessEnvelope<Payload> | Payload>(
    `/api/sessions/${sessionId}/messages`,
    { content },
  );
  return unwrap(data);
}

/** 取会话已处理历史 + inflight。 */
export async function fetchHistory(
  sessionId: string,
): Promise<HistoryResponse> {
  const { data } = await apiClient.get<
    SuccessEnvelope<HistoryResponse> | HistoryResponse
  >(`/api/sessions/${sessionId}/history`);
  return unwrap(data);
}

/** 取会话排队中的用户消息。 */
export async function fetchPending(
  sessionId: string,
): Promise<PendingResponse> {
  const { data } = await apiClient.get<
    SuccessEnvelope<PendingResponse> | PendingResponse
  >(`/api/sessions/${sessionId}/pending`);
  return unwrap(data);
}
