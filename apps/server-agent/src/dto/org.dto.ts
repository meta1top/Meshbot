import { createI18nZodDto } from "@meshbot/common";
import { type SwitchOrgInput, SwitchOrgSchema } from "@meshbot/types-main";

/**
 * 组织代理 DTO（精简版）：仅保留组织切换所需。
 * 组织管理操作（建组织/邀请/接受邀请）的 DTO 已转移到云端。
 */

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class SwitchOrgDto extends createI18nZodDto(SwitchOrgSchema) {}
export interface SwitchOrgDto extends SwitchOrgInput {}
