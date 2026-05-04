import { z } from "zod";

export const registerSchema = z.object({
  username: z.string().min(1, "请输入用户名").max(50),
  password: z.string().min(6, "密码至少 6 位").max(100),
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export type LoginInput = z.infer<typeof loginSchema>;

export interface AuthStatus {
  initialized: boolean;
  needsSetup: boolean;
}

export interface LoginResponse {
  access_token: string;
}

export interface UserInfo {
  id: string;
  username: string;
}
