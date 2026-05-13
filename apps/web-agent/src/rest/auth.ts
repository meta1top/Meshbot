"use client";

import { apiClient, setAccessToken } from "@meshbot/web-common";
import type {
  AuthStatus,
  LoginInput,
  LoginResponse,
  RegisterInput,
} from "@meshbot/types-agent";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

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
  return useMutation({
    mutationFn: login,
  });
}

export function useRegister() {
  return useMutation({
    mutationFn: register,
  });
}
