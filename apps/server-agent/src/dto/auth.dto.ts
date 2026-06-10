import { createI18nZodDto } from "@meshbot/common";
import {
  type LoginInput,
  LoginSchema,
  type RegisterUserInput,
  RegisterUserSchema,
} from "@meshbot/types-main";

/**
 * 认证 DTO 复用云端共享 schema（@meshbot/types-main）：
 * 本地代理与云端 server-main 校验规则 / i18n 文案完全一致。
 *
 * class + interface 声明合并：class 提供 isZodDto（全局 I18nZodValidationPipe
 * 识别），interface 把 z.infer 字段平铺到实例类型。
 */

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class RegisterDto extends createI18nZodDto(RegisterUserSchema) {}
export interface RegisterDto extends RegisterUserInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class LoginDto extends createI18nZodDto(LoginSchema) {}
export interface LoginDto extends LoginInput {}
