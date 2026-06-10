"use client";

import type {
  CreateOrgInput,
  InvitationInfo,
  JoinOrgInput,
  MemberInfo,
  OrgInfo,
} from "@meshbot/types-agent";
import { apiClient } from "@meshbot/web-common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { profileQueryKey } from "@/lib/profile-client";
import { authStatusQueryKey } from "@/rest/auth";

export async function createOrg(input: CreateOrgInput): Promise<OrgInfo> {
  const { data } = await apiClient.post<OrgInfo>("/api/orgs", input);
  return data;
}

export async function joinOrg(
  input: JoinOrgInput,
): Promise<{ orgId: string; orgName: string }> {
  const { data } = await apiClient.post<{ orgId: string; orgName: string }>(
    "/api/orgs/invitations/accept",
    input,
  );
  return data;
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

export function useCreateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createOrg,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: profileQueryKey });
      qc.invalidateQueries({ queryKey: authStatusQueryKey });
    },
  });
}

export function useJoinOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: joinOrg,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: profileQueryKey });
      qc.invalidateQueries({ queryKey: authStatusQueryKey });
    },
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
