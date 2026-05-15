import { z } from "zod";

/** 登录。密码不在 schema 层校验长度（错误密码统一抛 invalidCredentials）。 */
export const LoginSchema = z.object({
  email: z.string().email({ message: "validation.invalidEmail" }),
  password: z.string().min(1, { message: "validation.required" }),
});

export type LoginInput = z.infer<typeof LoginSchema>;
