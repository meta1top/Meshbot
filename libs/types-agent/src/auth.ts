import { z } from "zod";

/** 浏览器授权登录：手动粘贴授权码兜底表单（回调失败 / 无 loopback 场景）。 */
export const authorizeCodeSchema = z.object({
  code: z.string().min(1, "login.validation.codeRequired"),
});
export type AuthorizeCodeInput = z.infer<typeof authorizeCodeSchema>;

/**
 * setup-status 三态：needs-login → needs-model → ready。
 * 组织归属现由云端浏览器授权登录流程（web-main 注册/组织向导）保证，
 * 本地不再有 needs-org 分流。
 */
export type SetupStep = "needs-login" | "needs-model" | "ready";

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
