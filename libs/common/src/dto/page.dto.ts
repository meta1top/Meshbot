import {
  type PageData,
  type PageRequest,
  PageRequestSchema,
} from "@meshbot/types";

import { createI18nZodDto } from "./create-i18n-zod-dto";

/**
 * 通用分页请求 DTO —— Phase 5 Track B1。
 *
 * 用法：
 * ```ts
 * @Get()
 * async listAgents(@Query() q: PageRequestDto) {
 *   return this.agents.findPage(q);  // 返回 PageData<AgentDto>
 * }
 * ```
 *
 * 错误信息走 i18n key（validation.* 命名空间），由 `I18nZodValidationPipe` 翻译。
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: intentional class+interface merge to expose zod-inferred fields
export class PageRequestDto extends createI18nZodDto(PageRequestSchema) {}
export interface PageRequestDto extends PageRequest {}

/**
 * 构造 `PageData<T>` —— Service 层返回时的便利 helper。
 *
 * ```ts
 * async findPage(q: PageRequest): Promise<PageData<AgentDto>> {
 *   const [items, total] = await this.repo.findAndCount({
 *     skip: (q.page - 1) * q.size,
 *     take: q.size,
 *   });
 *   return pageify(items, total);
 * }
 * ```
 */
export function pageify<T>(items: T[], total: number): PageData<T> {
  return { items, total };
}
