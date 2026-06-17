"use client";

import { apiClient } from "@meshbot/web-common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** 伴生会话信息（Plan 3a 后端返回）。 */
export interface AgentSession {
  sessionId: string;
  agentEnabled: boolean;
  convType: "channel" | "dm";
}

/** 取（或惰性建）某 IM 会话的伴生会话 id + 开关。 */
export async function fetchAgentSession(
  conversationId: string,
): Promise<AgentSession> {
  const { data } = await apiClient.get<AgentSession>(
    `/api/im/${conversationId}/agent-session`,
  );
  return data;
}

/** 切换某 IM 会话伴生 Agent 开关。 */
export async function setAgentEnabled(
  conversationId: string,
  enabled: boolean,
): Promise<{ ok: true }> {
  const { data } = await apiClient.put<{ ok: true }>(
    `/api/im/${conversationId}/agent-session`,
    { enabled },
  );
  return data;
}

/** 伴生会话 query key。 */
export function agentSessionKey(conversationId: string): string[] {
  return ["im-agent-session", conversationId];
}

/** 订阅某会话的伴生会话信息；conversationId 为空时不发请求。 */
export function useAgentSession(conversationId: string | null) {
  return useQuery({
    queryKey: agentSessionKey(conversationId ?? ""),
    queryFn: () => fetchAgentSession(conversationId as string),
    enabled: !!conversationId,
  });
}

/** 切换伴生 Agent 开关；成功后刷新该会话伴生信息。 */
export function useSetAgentEnabled(conversationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => setAgentEnabled(conversationId, enabled),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: agentSessionKey(conversationId) });
    },
  });
}
