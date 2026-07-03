import type {
  AcceptInvitationInput,
  CreateOrgInput,
  OrgSummary,
} from "@meshbot/types-main";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { mainApi } from "@/lib/api";
import { PROFILE_QUERY_KEY } from "@/rest/auth";

/**
 * 组织相关 mutation hooks（web-main 域）。
 *
 * 当前仅收纳 `/authorize` 无组织引导（建组织 / 接受邀请）所需的两个 mutation；
 * 组织管理页（成员列表/邀请/撤销等，Task 18）会继续扩这个文件。
 */

/** 创建组织（当前用户成为 owner，后端同时置为 activeOrg）。成功后 invalidate profile 使新组织生效。 */
export function useCreateOrg() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateOrgInput) =>
      (await mainApi.post<OrgSummary>("/api/orgs", input)).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    },
  });
}

/** 接受邀请（粘贴邀请码）。成功后后端置为 activeOrg（若之前未加入任何组织），invalidate profile 使其生效。 */
export function useAcceptInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AcceptInvitationInput) =>
      (
        await mainApi.post<{ orgId: string; orgName: string }>(
          "/api/orgs/invitations/accept",
          input,
        )
      ).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    },
  });
}
