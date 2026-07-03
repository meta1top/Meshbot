import { z } from "zod";

/** 校验注册邮箱验证码（6 位数字）。message 写 i18n key，由 `I18nZodValidationPipe` 翻译。 */
export const VerifyEmailSchema = z.object({
  email: z.string().email({ message: "validation.invalidEmail" }),
  code: z.string().length(6, { message: "validation.invalidFormat" }),
});
export type VerifyEmailInput = z.infer<typeof VerifyEmailSchema>;

/** 重发验证码。未知邮箱也走同一 schema，是否枚举由 controller/service 静默处理。 */
export const ResendCodeSchema = z.object({
  email: z.string().email({ message: "validation.invalidEmail" }),
});
export type ResendCodeInput = z.infer<typeof ResendCodeSchema>;
