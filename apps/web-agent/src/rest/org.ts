"use client";

import type { InvitationInfo, MemberInfo, OrgInfo } from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/** 我的组织列表查询 key。 */
export const orgsQueryKey = ["org", "list"] as const;

export async function fetchOrgs(): Promise<OrgInfo[]> {
  const { data } = await apiClient.get<OrgInfo[]>("/api/orgs");
  return data;
}

/**
 * 切换活跃组织：调 server-agent 代理，成功后失效 profile/authStatus/org 相关查询。
 */
export async function switchOrg(orgId: string): Promise<void> {
  await apiClient.post("/api/orgs/switch", { orgId });
}

export async function fetchMembers(orgId: string): Promise<MemberInfo[]> {
  const { data } = await apiClient.get<MemberInfo[]>(
    `/api/orgs/${orgId}/members`,
  );
  return data;
}

export async function fetchInvitations(
  orgId: string,
): Promise<InvitationInfo[]> {
  const { data } = await apiClient.get<InvitationInfo[]>(
    `/api/orgs/${orgId}/invitations`,
  );
  return data;
}

export async function inviteMember(
  orgId: string,
  email: string,
): Promise<InvitationInfo> {
  const { data } = await apiClient.post<InvitationInfo>(
    `/api/orgs/${orgId}/invitations`,
    { email },
  );
  return data;
}

/** 当前账号的组织列表（含所有 membership）。 */
export function useOrgs() {
  return useQuery({
    queryKey: orgsQueryKey,
    queryFn: fetchOrgs,
  });
}

export function useMembers(orgId: string | null) {
  return useQuery({
    queryKey: ["org", orgId, "members"],
    queryFn: () => fetchMembers(orgId as string),
    enabled: orgId != null,
  });
}

export function useInvitations(orgId: string | null, isOwner: boolean) {
  return useQuery({
    queryKey: ["org", orgId, "invitations"],
    queryFn: () => fetchInvitations(orgId as string),
    enabled: orgId != null && isOwner,
  });
}

export function useInviteMember(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => inviteMember(orgId, email),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["org", orgId, "invitations"] });
    },
  });
}
