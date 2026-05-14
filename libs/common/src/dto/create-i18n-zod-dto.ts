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
 * 返回类型复用 Phase 1 的 `ZodDtoClass<TSchema>`，保持 API 一致。
 *
 * ⚠️ Phase 2 已知缺口：当前 nestjs-i18n 的 `I18nValidationPipe` 不识别 Zod DTO，
 * 用 `createI18nZodDto` 派生的 DTO **在 production 当前不会触发校验**。Phase 3
 * 会引入 `I18nZodValidationPipe` 桥接（让 Zod 报错也走 i18n 翻译路径）。
 * 在桥接落地前，新 controller 请**继续使用 `createZodDto`**（Phase 1，无 i18n 但
 * 校验确实生效）；切换到 `createI18nZodDto` 等 Phase 3 桥接到位后统一迁移。
 *
 * 集成测试见 `apps/server-agent/test/e2e/dto-i18n.spec.ts`（含 Phase 2 行为
 * 与 Phase 3 期望的对照）。
 */
export function createI18nZodDto<TSchema extends ZodTypeAny>(schema: TSchema) {
  return createZodDtoBase(schema) as unknown as ZodDtoClass<TSchema>;
}
