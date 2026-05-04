import { useMutation, useQuery } from "@tanstack/react-query";
import { apiClient, setAccessToken } from "@anybot/common";
import type { AuthStatus, LoginInput, LoginResponse, RegisterInput } from "@anybot/types-agent";

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const { data } = await apiClient.get<AuthStatus>("/api/auth/status");
  return data;
}

export async function login(input: LoginInput): Promise<LoginResponse> {
  const { data } = await apiClient.post<LoginResponse>("/api/auth/login", input);
  setAccessToken(data.access_token);
  return data;
}

export async function register(input: RegisterInput): Promise<LoginResponse> {
  const { data } = await apiClient.post<LoginResponse>("/api/auth/register", input);
  setAccessToken(data.access_token);
  return data;
}

export function useAuthStatus() {
  return useQuery({
    queryKey: ["auth", "status"],
    queryFn: fetchAuthStatus,
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
