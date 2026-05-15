import {
  type ArgumentMetadata,
  BadRequestException,
  Injectable,
  type PipeTransform,
} from "@nestjs/common";
import { I18nContext, type I18nService } from "nestjs-i18n";
import type { ZodIssue } from "zod";

import type { ZodDtoClass } from "./create-zod-dto";

/**
 * Zod DTO 校验 + i18n 翻译桥。
 *
 * 桥接 `nestjs-zod`（Zod schema）与 `nestjs-i18n`（class-validator 走的 i18n 翻译）：
 * - 输入 `metatype` 必须是 `createZodDto` / `createI18nZodDto` 派生的 DTO 类
 *   （特征：构造函数 + 静态 `schema`）
 * - 校验失败时，把 `issue.message`（写成 i18n key，如 `"validation.required"`）
 *   通过 `I18nService.translate` 翻译为当前请求 lang 的文案，再统一抛 400
 * - 非 DTO 参数（普通 metatype，比如 `string` / `number` 透传）原样放行，不破坏
 *   其它 Pipe 链
 *
 * 替代 `nestjs-i18n` 自带的 `I18nValidationPipe`（只识别 class-validator 报错形态，
 * 不认 Zod 的 `ZodIssue[]`）。Phase 3 全局注册见 `apps/server-{agent,main}/src/main.ts`。
 */
@Injectable()
export class I18nZodValidationPipe implements PipeTransform {
  constructor(private readonly i18n: I18nService) {}

  transform(value: unknown, metadata: ArgumentMetadata) {
    const cls = metadata.metatype as ZodDtoClass<any> | undefined;
    if (!cls || typeof cls !== "function" || !("schema" in cls)) return value;

    const parsed = cls.schema.safeParse(value);
    if (parsed.success) return parsed.data;

    const lang = I18nContext.current()?.lang ?? "zh";
    const errors = parsed.error.issues.map((issue: ZodIssue) => ({
      path: issue.path.join("."),
      message: this.tryTranslate(issue.message, lang, issue),
    }));
    throw new BadRequestException({
      statusCode: 400,
      message: "Validation failed",
      errors,
    });
  }

  private tryTranslate(raw: string, lang: string, issue: ZodIssue): string {
    if (!raw || !raw.includes(".")) return raw;
    try {
      const translated = this.i18n.translate(raw, {
        lang,
        args: {
          min: (issue as { minimum?: unknown }).minimum,
          max: (issue as { maximum?: unknown }).maximum,
          received: (issue as { received?: unknown }).received,
        },
      }) as string;
      return translated ?? raw;
    } catch {
      return raw;
    }
  }
}
