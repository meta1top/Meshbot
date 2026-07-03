"use client";

import type { AuthStatus, LoginResponse } from "@meshbot/types-agent";
import {
  addAccount,
  apiClient,
  clearAccessToken,
  setAccessToken,
} from "@meshbot/web-common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { profileQueryKey } from "@/lib/profile-client";

export const authStatusQueryKey = ["auth", "status"] as const;
export const cloudWebUrlQueryKey = ["auth", "cloud-web-url"] as const;

function useClientMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const { data } = await apiClient.get<AuthStatus>("/api/setup-status");
  return data;
}

function decodeJwtPayload(
  token: string,
): { sub?: string; email?: string } | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    return JSON.parse(atob(part)) as { sub?: string; email?: string };
  } catch {
    return null;
  }
}

/**
 * 落地登录态：写活跃 token + 解 JWT sub/email upsert 多账号 store。
 * 浏览器授权轮询命中 / 手动粘贴授权码成功后均走这条路径。
 */
export function applyAuthToken(access_token: string): void {
  setAccessToken(access_token);
  const payload = decodeJwtPayload(access_token);
  if (payload?.sub) {
    addAccount(payload.sub, access_token, { email: payload.email });
  }
}

export interface AuthorizeStartResult {
  requestId: string;
  authorizeUrl: string;
}

/** 发起浏览器授权登录：拿云端授权页 URL，前端负责 `window.open`。 */
export async function startAuthorize(): Promise<AuthorizeStartResult> {
  const { data } = await apiClient.post<AuthorizeStartResult>(
    "/api/auth/authorize/start",
  );
  return data;
}

export type AuthorizePollResult =
  | { status: "pending" }
  | { status: "done"; access_token: string };

/** 轮询本地登录态（一次性；命中后服务端即失效该条目）。 */
export async function pollAuthorize(
  requestId: string,
): Promise<AuthorizePollResult> {
  const { data } = await apiClient.post<AuthorizePollResult>(
    "/api/auth/authorize/poll",
    { requestId },
  );
  return data;
}

/** 手动粘贴授权码完成登录（回调失败 / 无 loopback 场景兜底）。 */
export async function completeAuthorize(code: string): Promise<LoginResponse> {
  const { data } = await apiClient.post<LoginResponse>(
    "/api/auth/authorize/complete",
    { code },
  );
  return data;
}

export interface CloudWebUrl {
  webMainBase: string;
}

/** 云端 web-main 前端基础 URL（拼注册页 / 组织后台跳转链接）。 */
export async function fetchCloudWebUrl(): Promise<CloudWebUrl> {
  const { data } = await apiClient.get<CloudWebUrl>("/api/auth/cloud-web-url");
  return data;
}

/** webMainBase 是部署期静态配置，`staleTime: Infinity` —— 拿到一次后不再重新请求。 */
export function useCloudWebUrl() {
  return useQuery({
    queryKey: cloudWebUrlQueryKey,
    queryFn: fetchCloudWebUrl,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export async function logout(): Promise<void> {
  await apiClient.post("/api/auth/logout");
}

export function useAuthStatus() {
  const mounted = useClientMounted();
  return useQuery({
    queryKey: authStatusQueryKey,
    queryFn: fetchAuthStatus,
    enabled: mounted,
    retry: 2,
    retryDelay: 600,
    networkMode: "always",
  });
}

/**
 * 登出：先调服务端登出（需要 Bearer），settle 后再清本地 token + 缓存。
 * 云端不可达时调用方可 catch 忽略，onSettled 仍保证本地登出。
 *
 * 单账号模型：清空整个本地账号 store（token + meshbot_accounts），
 * 退出后回登录页；切换账号 = 退出后重新登录。
 */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: logout,
    onSettled: () => {
      clearAccessToken();
      queryClient.invalidateQueries({ queryKey: profileQueryKey });
      queryClient.invalidateQueries({ queryKey: authStatusQueryKey });
    },
  });
}

export { fetchProfile, ProfileUnauthorizedError } from "@/lib/profile-client";
