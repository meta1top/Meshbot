"use client";

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
