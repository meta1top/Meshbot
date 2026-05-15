import { createZodDto as createZodDtoBase } from "nestjs-zod";
import type { ZodTypeAny } from "zod";

import type { ZodDtoClass } from "./create-zod-dto";

/**
 * i18n 感知 DTO。
 *
 * Zod schema 的 message 写 i18n key（如 `"validation.stringTooShort"`），
 * 由全局 `I18nZodValidationPipe` 在 request 时翻译为当前 locale 的文案。
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
 * 返回类型复用 Phase 1 的 `ZodDtoClass<TSchema>`，保持 API 一致。
 *
 * Phase 3 起配合 `I18nZodValidationPipe`（`apps/server-*` 全局 pipe）生效：
 * 校验失败时把 `issue.message`（i18n key）通过 `I18nService.translate` 翻译为
 * 当前请求 lang 的文案。集成测试见
 * `apps/server-agent/test/e2e/dto-i18n.spec.ts`。
 */
export function createI18nZodDto<TSchema extends ZodTypeAny>(schema: TSchema) {
  return createZodDtoBase(schema) as unknown as ZodDtoClass<TSchema>;
}
