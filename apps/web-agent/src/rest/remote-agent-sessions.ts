"use client";

import type { HistoryResponse, SessionSummary } from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";

/**
 * 拉取在线远程 Agent（其宿主设备）的会话列表（经本地 server-agent → relay 跨设备只读查询）。
 * 目标设备离线 / 跨账号 / 超时 → 服务端 409/504，调用方 catch 处理。
 */
export async function fetchRemoteSessions(
  agentId: string,
): Promise<SessionSummary[]> {
  const { data } = await apiClient.get<SessionSummary[]>(
    `/api/remote-agents/${agentId}/sessions`,
  );
  return data;
}

/**
 * 拉取远程 Agent（其宿主设备）某会话历史（只读）。
 *
 * 注意：类型标注为 HistoryResponse，但运行时 B 侧是把
 * `SessionMessageService.listPage()` 的原始 SessionMessage 行直接回传
 * （toolCalls/metadata 是未解析的 JSON 字符串、无 feedback 字段、可能含
 * role="tool" 行），并非真正的 HistoryMessage。调用方渲染前必须防御式映射，
 * 不能直接假设字段形状与本地 `/api/sessions/:id/history` 一致。
 */
export async function fetchRemoteHistory(
  agentId: string,
  sessionId: string,
  opts?: { before?: string; limit?: number },
): Promise<HistoryResponse> {
  const q = new URLSearchParams();
  if (opts?.before) q.set("before", opts.before);
  if (opts?.limit) q.set("limit", String(opts.limit));
  const qs = q.toString();
  const { data } = await apiClient.get<HistoryResponse>(
    `/api/remote-agents/${agentId}/sessions/${sessionId}/history${qs ? `?${qs}` : ""}`,
  );
  return data;
}

/** POST /api/remote-agents/:id/run 出参：仅 streamId，sessionId（create 模式）经影子帧回报。 */
export interface StartRemoteRunResult {
  streamId: string;
}

/** POST /api/remote-agents/:id/run 入参。mode=create 时 sessionId 留空，由 B 新建后经首帧回报。 */
export interface StartRemoteRunInput {
  mode: "create" | "append";
  sessionId?: string;
  content: string;
}

/**
 * L3：发起对远程 Agent（其宿主设备 B）的 run。mode=create 让 B 新建会话（本次调用只拿到
 * streamId，B 的会话 id 经 WS 影子帧回报）；mode=append 续写 B 上已存在的会话。
 */
export async function startRemoteRun(
  agentId: string,
  input: StartRemoteRunInput,
): Promise<StartRemoteRunResult> {
  const { data } = await apiClient.post<StartRemoteRunResult>(
    `/api/remote-agents/${agentId}/run`,
    input,
  );
  return data;
}

/** L3：中断远程 Agent（其宿主设备 B）上指定 streamId 对应的运行。 */
export async function interruptRemoteRun(
  agentId: string,
  input: { streamId: string; sessionId: string },
): Promise<void> {
  await apiClient.post(`/api/remote-agents/${agentId}/run/interrupt`, input);
}

/**
 * L3 Phase B：对远程 Agent（其宿主设备 B）上指定 streamId 的 confirm 型 HITL 卡片下发决策
 * （发送 / 取消，可带编辑后的 content），经 A 端点转发到 B 侧同一次 run。
 */
export async function confirmRemote(
  agentId: string,
  body: {
    streamId: string;
    sessionId: string;
    toolCallId: string;
    decision: "send" | "cancel";
    content?: string;
  },
): Promise<{ ok: true }> {
  const { data } = await apiClient.post<{ ok: true }>(
    `/api/remote-agents/${agentId}/run/confirm`,
    body,
  );
  return data;
}

/**
 * L3 Phase B：对远程 Agent（其宿主设备 B）上指定 streamId 的 ask_question 型 HITL 卡片
 * 下发用户作答，经 A 端点转发到 B 侧同一次 run。
 */
export async function answerRemote(
  agentId: string,
  body: {
    streamId: string;
    sessionId: string;
    toolCallId: string;
    answers: { selected: string[]; other?: string }[];
  },
): Promise<{ ok: true }> {
  const { data } = await apiClient.post<{ ok: true }>(
    `/api/remote-agents/${agentId}/run/answer`,
    body,
  );
  return data;
}

/**
 * L3 Phase B：查询远程 Agent（其宿主设备 B）上某 streamId 或 sessionId 当前对应的活跃 run，
 * 用于「刷新/直接进入远程会话」时回填 streamId（reclaim）——本页尚未发起过
 * run，本地无 streamId 记忆，靠这个端点找回，使 confirm/interrupt 恢复可用。
 * 查无结果（无活跃 run）返回 null。
 */
export async function fetchRemoteRun(
  agentId: string,
  q: { streamId?: string; sessionId?: string },
): Promise<{ streamId: string; sessionId: string | null } | null> {
  const params = new URLSearchParams();
  if (q.streamId) params.set("streamId", q.streamId);
  if (q.sessionId) params.set("sessionId", q.sessionId);
  const { data } = await apiClient.get<{
    streamId: string;
    sessionId: string | null;
  } | null>(`/api/remote-agents/${agentId}/runs?${params.toString()}`);
  return data;
}

/** 切换远程会话绑定的模型（写对端 session；模型 id 云端下发跨设备一致）。 */
export async function patchRemoteSessionModel(
  agentId: string,
  sessionId: string,
  modelConfigId: string,
): Promise<void> {
  await apiClient.patch(
    `/api/remote-agents/${agentId}/sessions/${sessionId}/model`,
    { modelConfigId },
  );
}

/** 读远程 Agent（其宿主设备）会话产物：≤2MB 内联 base64，超限返回 too-large 信号。 */
export async function fetchRemoteArtifact(
  agentId: string,
  sessionId: string,
  path: string,
): Promise<
  | { kind: "content"; name: string; base64: string }
  | { kind: "too-large"; name: string; size: number }
> {
  const res = await apiClient.get(
    `/api/remote-agents/${encodeURIComponent(agentId)}/artifact`,
    { params: { sessionId, path } },
  );
  return res.data;
}

/** 远程大产物上传组织网盘（B 设备执行），返回网盘文件引用。 */
export async function uploadRemoteArtifactToDrive(
  agentId: string,
  sessionId: string,
  path: string,
): Promise<{ fileId: string; name: string }> {
  const res = await apiClient.post(
    `/api/remote-agents/${encodeURIComponent(agentId)}/artifact/upload-drive`,
    { sessionId, path },
  );
  return res.data;
}
