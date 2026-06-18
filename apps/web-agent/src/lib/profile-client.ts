"use client";

import type { UserInfo } from "@meshbot/types-agent";
import { getAccessToken, getBrowserApiBaseUrl } from "@meshbot/web-common";

/** profile 查询的 queryKey —— atom 与 invalidate 共用。 */
export const profileQueryKey = ["auth", "profile"] as const;

/** profile 请求未授权（401）—— AuthGuard 据此走 setup-status 分流。 */
export class ProfileUnauthorizedError extends Error {
  constructor() {
    super("profile unauthorized");
    this.name = "ProfileUnauthorizedError";
  }
}

/**
 * 请求当前用户 profile。
 *
 * 独立于 apiClient —— apiClient 的 401 拦截器会硬跳转 /login，与 AuthGuard
 * 的 401 分流（可能要去 /register）冲突。这里 401 抛 ProfileUnauthorizedError
 * 交给 AuthGuard 决策。响应走 server envelope，手动取内层 data。
 */
export async function fetchProfile(): Promise<UserInfo> {
  const base = getBrowserApiBaseUrl();
  const token = getAccessToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${base}/api/auth/profile`, { headers });
  if (res.status === 401) {
    throw new ProfileUnauthorizedError();
  }
  if (!res.ok) {
    throw new Error(`profile request failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: UserInfo } & UserInfo;
  return (body.data ?? body) as UserInfo;
}
