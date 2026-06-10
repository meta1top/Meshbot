import { createI18nZodDto } from "@meshbot/common";
import {
  type AcceptInvitationInput,
  AcceptInvitationSchema,
  type CreateInvitationInput,
  CreateInvitationSchema,
  type CreateOrgInput,
  CreateOrgSchema,
} from "@meshbot/types-main";

/**
 * 组织代理 DTO 复用云端共享 schema（@meshbot/types-main），
 * 与 auth.dto.ts 同款 class + interface 声明合并模式。
 */

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class CreateOrgDto extends createI18nZodDto(CreateOrgSchema) {}
export interface CreateOrgDto extends CreateOrgInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class InviteMemberDto extends createI18nZodDto(CreateInvitationSchema) {}
export interface InviteMemberDto extends CreateInvitationInput {}

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class AcceptInvitationDto extends createI18nZodDto(
  AcceptInvitationSchema,
) {}
export interface AcceptInvitationDto extends AcceptInvitationInput {}
