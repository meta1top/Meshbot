import { IM_WS_EVENTS } from "@meshbot/types";
import type { AgentView } from "@meshbot/types-main";
import {
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { mainApi } from "@/lib/api";
import { getImSocket } from "@/lib/im-socket";

/**
 * 云端 Agent 注册表 hooks（计划二 2b · T7）。`GET /api/agents`（T2，user JWT）
 * 列出当前用户已注册（未软删）的远程 Agent——寻址主键从设备细化到设备上的
 * 某个 Agent，`AgentView.id` 即 T5 网关寻址用的 `targetAgentId`。
 */

const AGENTS_QUERY_KEY = ["main", "agents"] as const;

/** 当前用户已注册的远程 Agent 列表。 */
export function useAgents(): UseQueryResult<AgentView[]> {
  return useQuery({
    queryKey: AGENTS_QUERY_KEY,
    queryFn: async () => (await mainApi.get<AgentView[]>("/api/agents")).data,
  });
}

/**
 * 订阅 `ws/im` 的 agent 注册表变更事件，实时失效 agent 列表缓存（Bug #12 修复）。
 * 设备侧关/开某 Agent 的「允许远程」→ 云端对账（软删/复活）后 server-main 推送
 * `agentRegistryChanged` → 这里 `invalidateQueries` 触发重新拉取 `GET /api/agents`，
 * 免手动刷新页面。事件不带 payload（纯失效信号，同 `modelConfigChanged` 的范式），
 * 具体差异由 REST 重拉后的响应体决定。挂载即订阅、卸载即清理，对齐
 * `useDevicePresenceSync`（`@/rest/agent-devices`）的写法。
 */
export function useAgentRegistrySync(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const socket = getImSocket();
    const onChanged = () => {
      queryClient.invalidateQueries({ queryKey: AGENTS_QUERY_KEY });
    };
    socket.on(IM_WS_EVENTS.agentRegistryChanged, onChanged);
    return () => {
      socket.off(IM_WS_EVENTS.agentRegistryChanged, onChanged);
    };
  }, [queryClient]);
}
