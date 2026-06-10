/** 组织角色。Phase 1 仅 owner / member。 */
export type OrgRole = "owner" | "member";

/** 邀请状态。 */
export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

/** 组织摘要（列表 / profile 用）。 */
export interface OrgSummary {
  id: string;
  name: string;
  role: OrgRole;
}

/** 成员摘要。 */
export interface MemberSummary {
  userId: string;
  email: string;
  displayName: string;
  role: OrgRole;
}

/** 邀请摘要（owner 查看用，含 token 供桌面端复制/重发文案）。 */
export interface InvitationSummary {
  id: string;
  email: string;
  status: InvitationStatus;
  /** 邀请码。owner 专用视图；如向普通成员返回须过滤掉该字段。 */
  token: string;
  expiresAt: string;
  createdAt: string;
}
