import type {
  ConversationSummary,
  CreateAgentDmInput,
  MessagePage,
} from "@meshbot/types";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { mainApi } from "@/lib/api";

/**
 * IM 会话 / 消息 / Agent-DM REST hooks（web-main 云协同前端）。
 * 首屏拉取走这里；新消息/未读/在线态的实时增量由 `ws/im` socket 承担（Task 14）。
 */

/** 会话列表 query key（当前用户在活跃组织内可见的全部会话）。 */
export const CONVERSATIONS_QUERY_KEY = ["main", "im", "conversations"] as const;

/** 当前用户在活跃组织内可见的会话列表（频道 + 私信 + Agent-DM）。 */
export function useConversations(): UseQueryResult<ConversationSummary[]> {
  return useQuery({
    queryKey: CONVERSATIONS_QUERY_KEY,
    queryFn: async () =>
      (await mainApi.get<ConversationSummary[]>("/api/conversations")).data,
  });
}

/**
 * 拉取某会话的历史消息（游标分页）。
 * `before` 传上一页最早一条消息的时间戳，省略则取最新一页；`limit` 由后端兜底默认值。
 */
export async function fetchMessages(
  conversationId: string,
  before?: string,
): Promise<MessagePage> {
  const res = await mainApi.get<MessagePage>(
    `/api/conversations/${conversationId}/messages`,
    { params: before ? { before } : undefined },
  );
  return res.data;
}

/** 创建或获取与指定设备 Agent 的私信（幂等）。成功后 invalidate 会话列表以带出新会话。 */
export function useCreateAgentDm() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateAgentDmInput) =>
      (await mainApi.post<ConversationSummary>("/api/agent-dms", input)).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: CONVERSATIONS_QUERY_KEY,
      });
    },
  });
}
