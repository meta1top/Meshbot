import { z } from "zod";

/**
 * 注册新用户。message 写 i18n key，由 `I18nZodValidationPipe` 翻译。
 */
export const RegisterUserSchema = z.object({
  email: z
    .string()
    .email({ message: "validation.invalidEmail" })
    .max(255, { message: "validation.stringTooLong" }),
  password: z
    .string()
    .min(8, { message: "validation.passwordTooShort" })
    .max(72, { message: "validation.stringTooLong" }),
  displayName: z
    .string()
    .min(1, { message: "validation.required" })
    .max(64, { message: "validation.stringTooLong" }),
});

export type RegisterUserInput = z.infer<typeof RegisterUserSchema>;
