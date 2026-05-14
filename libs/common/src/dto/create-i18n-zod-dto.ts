import { createZodDto as createZodDtoBase } from "nestjs-zod";
import type { ZodTypeAny } from "zod";

import type { ZodDtoClass } from "./create-zod-dto";

/**
 * i18n 感知 DTO。
 *
 * Zod schema 的 message 写 i18n key（如 `"validation.stringTooShort"`），
 * 由全局 `I18nValidationPipe` 在 request 时翻译为当前 locale 的文案。
 *
 * 用法：
 * ```ts
 * import { createI18nZodDto } from "@meshbot/common";
 * import { RegisterAgentSchema } from "@meshbot/types-main";
 *
 * export class RegisterAgentDto extends createI18nZodDto(RegisterAgentSchema) {}
 *
 * \@Post("register")
 * register(\@Body() dto: RegisterAgentDto) { ... }
 * ```
 *
 * 注：与 Phase 1 的 `createZodDto`（无 i18n 简化版）共存。
 * 新代码默认用 `createI18nZodDto`；纯校验场景（无 i18n 上下文）可继续用 `createZodDto`。
 * 返回类型复用 Phase 1 的 `ZodDtoClass<TSchema>`，保持 API 一致。
 */
export function createI18nZodDto<TSchema extends ZodTypeAny>(schema: TSchema) {
  return createZodDtoBase(schema) as unknown as ZodDtoClass<TSchema>;
}
