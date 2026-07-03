import type {
  LoginInput,
  OrgSummary,
  RegisterUserInput,
  ResendCodeInput,
  VerifyEmailInput,
} from "@meshbot/types-main";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { mainApi } from "@/lib/api";
import { setMainToken } from "@/lib/auth-storage";

/** 当前登录用户基本信息。 */
export interface ProfileUser {
  id: string;
  email: string;
  displayName: string;
}

/** `GET /api/auth/profile` 响应体（已解 envelope）。 */
export interface Profile {
  user: ProfileUser;
  activeOrg: OrgSummary | null;
  memberships: OrgSummary[];
}

/** login / verify-email / switch-org 共用的重签 token 响应体。 */
export interface AuthTokenResponse {
  token: string;
  expiresIn: string;
  user: ProfileUser;
}

/** react-query key：profile 变化时（登录/登出/切组织）统一 invalidate 此 key。 */
export const PROFILE_QUERY_KEY = ["main", "profile"] as const;

/** 拉取当前登录用户 profile；未登录 / token 失效时 401，交由 AuthGuard 处理跳转，此处不重试。 */
export function useProfile(): UseQueryResult<Profile> {
  return useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: async () => (await mainApi.get<Profile>("/api/auth/profile")).data,
    retry: false,
  });
}

/** 登录。成功即落 token 并使 profile 失效（触发重新拉取）。 */
export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: LoginInput) =>
      (await mainApi.post<AuthTokenResponse>("/api/auth/login", input)).data,
    onSuccess: (data) => {
      setMainToken(data.token);
      void queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    },
  });
}

/** 注册。成功返回 `{needVerify:true}`，不签 token，需接着走 verify-email。 */
export function useRegister() {
  return useMutation({
    mutationFn: async (input: RegisterUserInput) =>
      (await mainApi.post<{ needVerify: true }>("/api/auth/register", input))
        .data,
  });
}

/** 校验邮箱验证码——验证即登录，成功落 token 并使 profile 失效。 */
export function useVerifyEmail() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: VerifyEmailInput) =>
      (await mainApi.post<AuthTokenResponse>("/api/auth/verify-email", input))
        .data,
    onSuccess: (data) => {
      setMainToken(data.token);
      void queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    },
  });
}

/** 重发验证码。未知邮箱也返回 `{ok:true}`（防枚举），不代表邮件真的发出。 */
export function useResendCode() {
  return useMutation({
    mutationFn: async (input: ResendCodeInput) =>
      (await mainApi.post<{ ok: true }>("/api/auth/resend-code", input)).data,
  });
}
