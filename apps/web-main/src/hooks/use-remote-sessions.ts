"use client";

import type { SessionSummary } from "@meshbot/types-agent";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
// 相对路径而非 `@/lib/device-query`（T15b）：根 jest.config.ts 的 `@/` 映射只
// 指向 `apps/web-agent/src`（历史遗留，早年只有 web-agent 的文件被 jest 直接
// 加载过），本文件此前用 `@/` 从未被任何 spec 传递 import 过、这条隐患一直
// 潜伏；`use-agent-lifecycle-watch.spec.ts` 首次经 `remoteSessionsQueryKey`
// 传递 import 到本文件，才在 `npx jest apps/web-main` 下暴露成「Could not
// locate module」。相对路径在 jest / tsc / Next.js 三边都能正确解析，修复
// 一次性解决，不必额外给根 jest 配置加 web-main 专属别名。
import { remoteQuery } from "../lib/device-query";

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
