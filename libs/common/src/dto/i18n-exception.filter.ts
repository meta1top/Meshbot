import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
} from "@nestjs/common";
import { I18nContext, type I18nService } from "nestjs-i18n";

interface HttpResponseLike {
  status(code: number): this;
  json(body: unknown): unknown;
}

/**
 * 把 HttpException 的 `message` 当作 i18n key 翻译为请求 lang 的文案。
 *
 * - Pipe 校验失败已由 `I18nZodValidationPipe` 单独翻译，本 filter 跳过其 422/400
 *   带 `errors[]` 结构的负载，避免双重翻译
 * - 仅当 message 形如 `<ns>.<key>` 且翻译命中时替换；否则原样返回
 *
 * 配合 service 层 `throwMainError(...)` 抛 i18n-key 用。
 */
@Catch(HttpException)
export class I18nExceptionFilter implements ExceptionFilter {
  constructor(private readonly i18n: I18nService) {}

  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<HttpResponseLike>();
    const status = exception.getStatus();
    const raw = exception.getResponse() as
      | string
      | { message?: string; errors?: unknown; [k: string]: unknown };

    // 透传 pipe 已结构化好的校验报错
    if (typeof raw === "object" && raw !== null && Array.isArray(raw.errors)) {
      res.status(status).json(raw);
      return;
    }

    const message = typeof raw === "string" ? raw : (raw.message ?? "");
    const lang = I18nContext.current()?.lang ?? "zh";
    const translated = this.tryTranslate(message, lang);

    const body =
      typeof raw === "object" && raw !== null
        ? { ...raw, message: translated }
        : { statusCode: status, message: translated };
    res.status(status).json(body);
  }

  private tryTranslate(raw: string, lang: string): string {
    if (!raw || !raw.includes(".")) return raw;
    try {
      const translated = this.i18n.translate(raw, { lang }) as string;
      // 翻译未命中时 nestjs-i18n 返回原 key —— 直接返回它即可
      return translated ?? raw;
    } catch {
      return raw;
    }
  }
}
