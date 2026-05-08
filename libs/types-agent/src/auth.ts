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
  step: "register" | "model" | null;
}

export interface LoginResponse {
  access_token: string;
}

export interface UserInfo {
  id: string;
  username: string;
}

// Local auth DTOs for CLI Agent standalone mode
export const RegisterDto = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(6).max(100),
});

export const LoginDto = z.object({
  username: z.string(),
  password: z.string(),
});

export const AuthResponse = z.object({
  accessToken: z.string(),
  user: z.object({
    id: z.number(),
    username: z.string(),
  }),
});

export type RegisterDto = z.infer<typeof RegisterDto>;
export type LoginDto = z.infer<typeof LoginDto>;
export type AuthResponse = z.infer<typeof AuthResponse>;
