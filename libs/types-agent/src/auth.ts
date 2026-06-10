import { z } from "zod";

/** 注册（云端身份）。密码规则与云端 RegisterUserSchema 一致。 */
export const registerSchema = z.object({
  email: z.string().email("login.validation.emailInvalid"),
  password: z
    .string()
    .min(8, "login.validation.passwordTooShort")
    .max(72, "login.validation.passwordTooLong"),
  displayName: z
    .string()
    .min(1, "login.validation.displayNameRequired")
    .max(64, "login.validation.displayNameTooLong"),
});
export type RegisterInput = z.infer<typeof registerSchema>;

/** 登录。 */
export const loginSchema = z.object({
  email: z.string().email("login.validation.emailInvalid"),
  password: z.string().min(1, "login.validation.passwordRequired"),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** 创建组织。 */
export const createOrgSchema = z.object({
  name: z
    .string()
    .min(1, "setup.validation.orgNameRequired")
    .max(64, "setup.validation.orgNameTooLong"),
});
export type CreateOrgInput = z.infer<typeof createOrgSchema>;

/** 加入组织（粘贴邀请码）。 */
export const joinOrgSchema = z.object({
  token: z.string().min(1, "setup.validation.inviteCodeRequired"),
});
export type JoinOrgInput = z.infer<typeof joinOrgSchema>;

/** setup-status 四态。 */
export type SetupStep = "needs-login" | "needs-org" | "needs-model" | "ready";

export interface AuthStatus {
  step: SetupStep;
  needsSetup: boolean;
}

export interface LoginResponse {
  access_token: string;
}

/** 活跃组织摘要。 */
export interface OrgInfo {
  id: string;
  name: string;
  role: "owner" | "member";
}

/** 当前用户（含活跃组织镜像）。 */
export interface UserInfo {
  id: string;
  email: string;
  displayName: string;
  org: OrgInfo | null;
}

/** 成员摘要。 */
export interface MemberInfo {
  userId: string;
  email: string;
  displayName: string;
  role: "owner" | "member";
}

/** 邀请摘要。 */
export interface InvitationInfo {
  id: string;
  email: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  token: string;
  expiresAt: string;
  createdAt: string;
}
