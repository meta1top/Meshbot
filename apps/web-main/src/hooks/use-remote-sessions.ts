"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { remoteQuery } from "@/lib/device-query";

/** 远程 Agent 会话列表 query key（侧栏树 / RemoteSessionView 共用，缓存互通）。
 * `agentId`：目标云端 Agent id（计划二 2b · T7：寻址从设备细化到设备上的某
 * Agent），不是设备 id。 */
export function remoteSessionsQueryKey(agentId: string) {
  return ["main", "remote-sessions", agentId] as const;
}

/**
 * 某远程 Agent 的会话列表：经 device-query 模块级单例往返（correlationId + 10s
 * 超时），不再绑 transport 实例——修复过「首个响应 settle 不到挂起 Promise、
 * 干等 10s 超时 + React Query 重试才出来」的 ~11s 慢加载（见 lib/device-query.ts）。
 * `enabled` 通常传宿主设备在线态：离线不发起。
 */
export function useRemoteSessions(
  agentId: string,
  enabled: boolean,
): UseQueryResult<SessionSummary[]> {
  return useQuery({
    queryKey: remoteSessionsQueryKey(agentId),
    queryFn: () =>
      remoteQuery(agentId, "sessions", {}) as Promise<SessionSummary[]>,
    enabled,
    staleTime: 15_000,
  });
}
