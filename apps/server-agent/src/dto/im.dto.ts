import { createI18nZodDto } from "@meshbot/common";
import {
  type AddChannelMemberInput,
  AddChannelMemberSchema,
  type CreateChannelInput,
  CreateChannelSchema,
  type CreateDmInput,
  CreateDmSchema,
} from "@meshbot/types";

/**
 * IM REST 代理 DTO：复用 @meshbot/types 共享 schema，
 * 与 org.dto.ts 同款 class + interface 声明合并模式。
 */

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
