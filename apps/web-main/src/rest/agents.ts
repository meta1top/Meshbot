import type { AgentView } from "@meshbot/types-main";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { mainApi } from "@/lib/api";

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
