"use client";

import type {
  AuthStatus,
  LoginInput,
  LoginResponse,
  RegisterInput,
} from "@meshbot/types-agent";
import {
  apiClient,
  clearAccessToken,
  setAccessToken,
} from "@meshbot/web-common";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { profileQueryKey } from "@/lib/profile-client";

export const authStatusQueryKey = ["auth", "status"] as const;

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

export async function login(input: LoginInput): Promise<LoginResponse> {
  const { data } = await apiClient.post<LoginResponse>(
    "/api/auth/login",
    input,
  );
  setAccessToken(data.access_token);
  return data;
}

export async function register(input: RegisterInput): Promise<LoginResponse> {
  const { data } = await apiClient.post<LoginResponse>(
    "/api/auth/register",
    input,
  );
  setAccessToken(data.access_token);
  return data;
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

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: login,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: profileQueryKey });
      queryClient.invalidateQueries({ queryKey: authStatusQueryKey });
    },
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: register,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: profileQueryKey });
      queryClient.invalidateQueries({ queryKey: authStatusQueryKey });
    },
  });
}

/**
 * 登出：先调服务端登出（需要 Bearer），settle 后再清本地 token + 缓存。
 * 云端不可达时调用方可 catch 忽略，onSettled 仍保证本地登出。
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
