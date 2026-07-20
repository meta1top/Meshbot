"use client";

import type { WatchScope } from "@meshbot/types";
import type { RemoteAgentView } from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";
import { useQuery } from "@tanstack/react-query";

/** 远程 Agent 列表 query key。 */
export const remoteAgentsQueryKey = ["remote-agents"] as const;

/** 拉同账号其他设备上已注册的远程 Agent（经本地 server-agent 代理云端）。 */
export async function listRemoteAgents(): Promise<RemoteAgentView[]> {
  const { data } = await apiClient.get<RemoteAgentView[]>("/api/remote-agents");
  return data;
}

/** 当前账号其他设备上的远程 Agent 列表（起手台 + 侧栏共用同一份缓存）。 */
export function useRemoteAgents() {
  return useQuery({
    queryKey: remoteAgentsQueryKey,
    queryFn: listRemoteAgents,
  });
}

/**
 * 发起对目标远程 Agent 的观察（Agent 级观察通道，T18/T19，web-agent 浏览器
 * 不直连云端，经本机 server-agent 代理）。`scope="agent"` 订该 Agent 的会话
 * 生命周期镜像（不带 sessionId）；`scope="session"` 订某个会话的推理帧（须带
 * `sessionId`，对应 T18 `RemoteWatchStartSchema` 的 refine 校验）。返回
 * `watchId`，注销时原样传给 {@link unwatchRemoteAgent}。
 */
export async function watchRemoteAgent(
  agentId: string,
  scope: WatchScope,
  sessionId?: string,
): Promise<{ watchId: string }> {
  const { data } = await apiClient.post<{ watchId: string }>(
    `/api/remote-agents/${agentId}/watch`,
    scope === "session" ? { scope, sessionId } : { scope },
  );
  return data;
}

/** 注销对目标远程 Agent 的观察（离开视图 / 组件卸载时调用）。 */
export async function unwatchRemoteAgent(
  agentId: string,
  watchId: string,
): Promise<void> {
  await apiClient.delete(`/api/remote-agents/${agentId}/watch/${watchId}`);
}
