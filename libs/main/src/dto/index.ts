import { createI18nZodDto } from "@meshbot/common";
import {
  type AcceptInvitationInput,
  AcceptInvitationSchema,
  type CreateInvitationInput,
  CreateInvitationSchema,
  type CreateOrgInput,
  CreateOrgSchema,
  type LoginInput,
  LoginSchema,
  type RegisterUserInput,
  RegisterUserSchema,
} from "@meshbot/types-main";

/**
 * 每个 DTO 用 class + interface 声明合并暴露解析后字段：
 * - class 部分：派生自 createI18nZodDto，NestJS 反射 / Swagger 看见构造函数 + isZodDto
 * - interface 部分：把 z.infer 的字段平铺到实例类型，让 controller 内 dto.xxx 通过 TS 检查
 *
 * 不写 interface 合并的话，`class X extends createI18nZodDto(S) {}` 派生类的实例字段不会自动暴露
 * （TS 限制：基类签名 `new(): T` 难以贯穿到子类 instance type）。
 *
 * Biome 的 noUnsafeDeclarationMerging 在此场景是合理误判（确为有意合并），逐个豁免。
 */

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class RegisterUserDto extends createI18nZodDto(RegisterUserSchema) {}
export interface RegisterUserDto extends RegisterUserInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class LoginDto extends createI18nZodDto(LoginSchema) {}
export interface LoginDto extends LoginInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class CreateOrgDto extends createI18nZodDto(CreateOrgSchema) {}
export interface CreateOrgDto extends CreateOrgInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class CreateInvitationDto extends createI18nZodDto(
  CreateInvitationSchema,
) {}
export interface CreateInvitationDto extends CreateInvitationInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class AcceptInvitationDto extends createI18nZodDto(
  AcceptInvitationSchema,
) {}
export interface AcceptInvitationDto extends AcceptInvitationInput {}
