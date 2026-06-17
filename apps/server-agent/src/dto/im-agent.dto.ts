import { createI18nZodDto } from "@meshbot/common";
import {
  type SetAgentEnabledInput,
  SetAgentEnabledSchema,
} from "@meshbot/types";

/** IM 伴生 Agent 开关切换 DTO：复用共享 schema。 */

// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class SetAgentEnabledDto extends createI18nZodDto(
  SetAgentEnabledSchema,
) {}
export interface SetAgentEnabledDto extends SetAgentEnabledInput {}
