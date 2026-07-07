"use client";

import type { HistoryResponse, SessionSummary } from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";

/**
 * 拉取在线远程设备的会话列表（经本地 server-agent → relay 跨设备只读查询）。
 * 目标设备离线 / 跨账号 / 超时 → 服务端 409/504，调用方 catch 处理。
 */
export async function fetchRemoteSessions(
  deviceId: string,
): Promise<SessionSummary[]> {
  const { data } = await apiClient.get<SessionSummary[]>(
    `/api/remote-devices/${deviceId}/sessions`,
  );
  return data;
}

/**
 * 拉取远程设备某会话历史（只读）。
 *
 * 注意：类型标注为 HistoryResponse，但运行时 B 侧是把
 * `SessionMessageService.listPage()` 的原始 SessionMessage 行直接回传
 * （toolCalls/metadata 是未解析的 JSON 字符串、无 feedback 字段、可能含
 * role="tool" 行），并非真正的 HistoryMessage。调用方渲染前必须防御式映射，
 * 不能直接假设字段形状与本地 `/api/sessions/:id/history` 一致。
 */
export async function fetchRemoteHistory(
  deviceId: string,
  sessionId: string,
  opts?: { before?: string; limit?: number },
): Promise<HistoryResponse> {
  const q = new URLSearchParams();
  if (opts?.before) q.set("before", opts.before);
  if (opts?.limit) q.set("limit", String(opts.limit));
  const qs = q.toString();
  const { data } = await apiClient.get<HistoryResponse>(
    `/api/remote-devices/${deviceId}/sessions/${sessionId}/history${qs ? `?${qs}` : ""}`,
  );
  return data;
}
