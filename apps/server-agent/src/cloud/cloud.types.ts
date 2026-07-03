/** 云端 profile data 部分。 */
export interface CloudProfileData {
  user: { id: string; email: string; displayName: string } | null;
  activeOrg: { id: string; name: string; role: string } | null;
  memberships: Array<{ id: string; name: string; role: string }>;
}

/** 云端组织摘要。 */
export interface CloudOrgSummary {
  id: string;
  name: string;
  role: string;
}
