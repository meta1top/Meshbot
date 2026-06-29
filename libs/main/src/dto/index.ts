import { createI18nZodDto } from "@meshbot/common";
import {
  type AddChannelMemberInput,
  AddChannelMemberSchema,
  type CreateChannelInput,
  CreateChannelSchema,
  type CreateDmInput,
  CreateDmSchema,
} from "@meshbot/types";
import {
  type AcceptInvitationInput,
  AcceptInvitationSchema,
  type CompleteUploadInput,
  CompleteUploadSchema,
  type CreateFolderInput,
  CreateFolderSchema,
  type CreateInvitationInput,
  CreateInvitationSchema,
  type CreateOrgInput,
  CreateOrgSchema,
  type CreateShareLinkInput,
  CreateShareLinkSchema,
  type LoginInput,
  LoginSchema,
  type RegisterUserInput,
  RegisterUserSchema,
  type RenameOrMoveInput,
  RenameOrMoveSchema,
  type RequestUploadInput,
  RequestUploadSchema,
  type SetGrantsInput,
  SetGrantsSchema,
  type SwitchOrgInput,
  SwitchOrgSchema,
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

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class CreateChannelDto extends createI18nZodDto(CreateChannelSchema) {}
export interface CreateChannelDto extends CreateChannelInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class CreateDmDto extends createI18nZodDto(CreateDmSchema) {}
export interface CreateDmDto extends CreateDmInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class AddChannelMemberDto extends createI18nZodDto(
  AddChannelMemberSchema,
) {}
export interface AddChannelMemberDto extends AddChannelMemberInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class SwitchOrgDto extends createI18nZodDto(SwitchOrgSchema) {}
export interface SwitchOrgDto extends SwitchOrgInput {}

export { PublishSkillDto } from "./skill.dto";

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class CreateFolderDto extends createI18nZodDto(CreateFolderSchema) {}
export interface CreateFolderDto extends CreateFolderInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class RequestUploadDto extends createI18nZodDto(RequestUploadSchema) {}
export interface RequestUploadDto extends RequestUploadInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class CompleteUploadDto extends createI18nZodDto(CompleteUploadSchema) {}
export interface CompleteUploadDto extends CompleteUploadInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class RenameOrMoveDto extends createI18nZodDto(RenameOrMoveSchema) {}
export interface RenameOrMoveDto extends RenameOrMoveInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class SetGrantsDto extends createI18nZodDto(SetGrantsSchema) {}
export interface SetGrantsDto extends SetGrantsInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class CreateShareLinkDto extends createI18nZodDto(
  CreateShareLinkSchema,
) {}
export interface CreateShareLinkDto extends CreateShareLinkInput {}
