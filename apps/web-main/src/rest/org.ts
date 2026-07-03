import type {
  AcceptInvitationInput,
  CreateInvitationInput,
  CreateOrgInput,
  InvitationSummary,
  MemberSummary,
  OrgSummary,
  SwitchOrgInput,
} from "@meshbot/types-main";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { mainApi } from "@/lib/api";
import { setMainToken } from "@/lib/auth-storage";
import { type AuthTokenResponse, PROFILE_QUERY_KEY } from "@/rest/auth";

/**
 * 组织相关 mutation hooks（web-main 域）。
 *
 * 收纳 `/authorize` 无组织引导（建组织 / 接受邀请）+ `/settings/org`
 * 组织管理页（成员列表 / 邀请 / 重发 / 撤销）+ 顶栏切组织 所需的全部 mutation。
 */

/** 成员列表 query key。 */
export const membersQueryKey = (orgId: string) =>
  ["main", "org", orgId, "members"] as const;

/** 待处理邀请列表 query key。 */
export const invitationsQueryKey = (orgId: string) =>
  ["main", "org", orgId, "invitations"] as const;

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

/** 组织成员列表（成员即可见）。`orgId` 为空（profile 尚未加载）时不发请求。 */
export function useMembers(
  orgId: string | null,
): UseQueryResult<MemberSummary[]> {
  return useQuery({
    queryKey: membersQueryKey(orgId ?? ""),
    queryFn: async () =>
      (await mainApi.get<MemberSummary[]>(`/api/orgs/${orgId}/members`)).data,
    enabled: orgId != null,
  });
}

/** 组织 pending 邀请列表（owner 限定，后端 403 会由调用方决定是否发起）。 */
export function useInvitations(
  orgId: string | null,
  enabled: boolean,
): UseQueryResult<InvitationSummary[]> {
  return useQuery({
    queryKey: invitationsQueryKey(orgId ?? ""),
    queryFn: async () =>
      (await mainApi.get<InvitationSummary[]>(`/api/orgs/${orgId}/invitations`))
        .data,
    enabled: enabled && orgId != null,
  });
}

/** 邀请成员（owner 限定）。成功后 invalidate 待处理邀请列表。 */
export function useInviteMember(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateInvitationInput) =>
      (
        await mainApi.post<InvitationSummary>(
          `/api/orgs/${orgId}/invitations`,
          input,
        )
      ).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: invitationsQueryKey(orgId),
      });
    },
  });
}

/** 重发邀请邮件（owner 限定）。成功后 invalidate 待处理邀请列表（过期邀请会被刷新 token）。 */
export function useResendInvitation(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (invitationId: string) =>
      (
        await mainApi.post<{ ok: true }>(
          `/api/orgs/${orgId}/invitations/${invitationId}/resend`,
        )
      ).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: invitationsQueryKey(orgId),
      });
    },
  });
}

/** 撤销邀请（owner 限定）。成功后 invalidate 待处理邀请列表。 */
export function useRevokeInvitation(orgId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (invitationId: string) =>
      (
        await mainApi.delete<{ ok: true }>(
          `/api/orgs/${orgId}/invitations/${invitationId}`,
        )
      ).data,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: invitationsQueryKey(orgId),
      });
    },
  });
}

/**
 * 切换当前活跃组织。成功后重签 token 落 storage + invalidate 全部查询
 * （不传 queryKey = invalidate 全量）——组织切换影响的数据面太广（成员/设备/
 * 模型配置/profile……），全量失效比精细失效更安全。
 */
export function useSwitchOrg() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: SwitchOrgInput) =>
      (await mainApi.post<AuthTokenResponse>("/api/auth/switch-org", input))
        .data,
    onSuccess: (data) => {
      setMainToken(data.token);
      void queryClient.invalidateQueries();
    },
  });
}
