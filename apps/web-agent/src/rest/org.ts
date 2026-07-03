"use client";

import type { MemberInfo, OrgInfo } from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";
import { useQuery } from "@tanstack/react-query";

/** 我的组织列表查询 key。 */
export const orgsQueryKey = ["org", "list"] as const;

export async function fetchOrgs(): Promise<OrgInfo[]> {
  const { data } = await apiClient.get<OrgInfo[]>("/api/orgs");
  return data;
}

/**
 * 切换活跃组织：调 server-agent 代理，成功后失效 profile/org 相关查询。
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
