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

/** POST /api/remote-devices/:id/run 出参：仅 streamId，sessionId（create 模式）经影子帧回报。 */
export interface StartRemoteRunResult {
  streamId: string;
}

/** POST /api/remote-devices/:id/run 入参。mode=create 时 sessionId 留空，由 B 新建后经首帧回报。 */
export interface StartRemoteRunInput {
  mode: "create" | "append";
  sessionId?: string;
  content: string;
}

/**
 * L3：发起对远程设备（B）的 run。mode=create 让 B 新建会话（本次调用只拿到
 * streamId，B 的会话 id 经 WS 影子帧回报）；mode=append 续写 B 上已存在的会话。
 */
export async function startRemoteRun(
  deviceId: string,
  input: StartRemoteRunInput,
): Promise<StartRemoteRunResult> {
  const { data } = await apiClient.post<StartRemoteRunResult>(
    `/api/remote-devices/${deviceId}/run`,
    input,
  );
  return data;
}

/** L3：中断远程设备（B）上指定 streamId 对应的运行。 */
export async function interruptRemoteRun(
  deviceId: string,
  input: { streamId: string; sessionId: string },
): Promise<void> {
  await apiClient.post(`/api/remote-devices/${deviceId}/run/interrupt`, input);
}

/**
 * L3 Phase B：对远程设备（B）上指定 streamId 的 confirm 型 HITL 卡片下发决策
 * （发送 / 取消，可带编辑后的 content），经 A 端点转发到 B 侧同一次 run。
 */
export async function confirmRemote(
  deviceId: string,
  body: {
    streamId: string;
    sessionId: string;
    toolCallId: string;
    decision: "send" | "cancel";
    content?: string;
  },
): Promise<{ ok: true }> {
  const { data } = await apiClient.post<{ ok: true }>(
    `/api/remote-devices/${deviceId}/run/confirm`,
    body,
  );
  return data;
}

/**
 * L3 Phase B：对远程设备（B）上指定 streamId 的 ask_question 型 HITL 卡片
 * 下发用户作答，经 A 端点转发到 B 侧同一次 run。
 */
export async function answerRemote(
  deviceId: string,
  body: {
    streamId: string;
    sessionId: string;
    toolCallId: string;
    answers: { selected: string[]; other?: string }[];
  },
): Promise<{ ok: true }> {
  const { data } = await apiClient.post<{ ok: true }>(
    `/api/remote-devices/${deviceId}/run/answer`,
    body,
  );
  return data;
}

/**
 * L3 Phase B：查询远程设备（B）上某 streamId 或 sessionId 当前对应的活跃 run，
 * 用于「刷新/直接进入远程会话」时回填 streamId（reclaim）——本页尚未发起过
 * run，本地无 streamId 记忆，靠这个端点找回，使 confirm/interrupt 恢复可用。
 * 查无结果（无活跃 run）返回 null。
 */
export async function fetchRemoteRun(
  deviceId: string,
  q: { streamId?: string; sessionId?: string },
): Promise<{ streamId: string; sessionId: string | null } | null> {
  const params = new URLSearchParams();
  if (q.streamId) params.set("streamId", q.streamId);
  if (q.sessionId) params.set("sessionId", q.sessionId);
  const { data } = await apiClient.get<{
    streamId: string;
    sessionId: string | null;
  } | null>(`/api/remote-devices/${deviceId}/runs?${params.toString()}`);
  return data;
}

/**
 * L3 create 模式的时序缺口兜底：B 新建的会话 id 只经 WS 影子帧回报，而影子帧
 * 走「session room」广播——A 前端此刻还不知道 sessionId、来不及提前订阅该
 * room，首帧存在丢失风险（socket.io 的 room 广播不重放给迟到的订阅者）。
 *
 * 用轮询 `fetchRemoteSessions` 兜底发现新会话 id：会话创建是 B 上同步落库
 * 操作，早于且独立于耗时的 LLM 首字生成，轮询窗口内几乎总能发现；用户自己
 * 发的首条消息也已同步落库，不依赖 run.human 帧即可在后续 `fetchRemoteHistory`
 * 里看到。发现新会话后，调用方改用真实 sessionId 走正常 session socket 订阅，
 * 后续实时帧走影子渲染正常到达（不再有时序问题）。
 *
 * @param excludeIds 发起 run 前先拍的该设备现有会话 id 集合（基线），
 *                    用于从轮询结果里识别出「新出现」的那个
 */
export async function waitForNewRemoteSession(
  deviceId: string,
  excludeIds: ReadonlySet<string>,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<string | null> {
  const intervalMs = opts.intervalMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const sessions = await fetchRemoteSessions(deviceId);
      const created = sessions.find((s) => !excludeIds.has(s.id));
      if (created) return created.id;
    } catch {
      // 单次轮询失败（网络抖动/relay 瞬时超时）忽略，继续重试直到超时
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
