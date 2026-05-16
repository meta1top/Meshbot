import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import { I18nContext, type I18nService } from "nestjs-i18n";

import { AppError } from "./app.error";
import { CommonErrorCode } from "./common.error-codes";

interface HttpResponseLike {
  status(code: number): this;
  json(body: unknown): unknown;
}

interface HttpRequestLike {
  url?: string;
  traceId?: string;
}

interface ErrorEnvelope {
  success: boolean;
  code: number;
  message: string;
  data: unknown;
  timestamp: string;
  path: string;
  traceId?: string;
}

/**
 * 全局异常 Filter —— Phase 5 Track A2。
 *
 * 兜底所有 throw（@Catch() 无参数）。输出统一 envelope：
 * ```json
 * {
 *   "success": false,
 *   "code": <ErrorCode.code>,
 *   "message": "<已翻译 i18n>",
 *   "data": <ErrorCode.data | null>,
 *   "timestamp": "ISO8601",
 *   "path": "/api/...",
 *   "traceId": "<x-trace-id>"
 * }
 * ```
 *
 * 处理分支：
 * 1. **AppError**：取 `errorCode` —— code / httpStatus / message（走 i18n）/ data
 * 2. **HttpException**：
 *    - 若 response 形如 `{ errors: [...] }`（来自 `I18nZodValidationPipe`），则
 *      `code = VALIDATION_FAILED.code`，`data = { errors }`
 *    - 否则 message 当 i18n key 翻译，code 用 -1（未分类业务错误）
 * 3. **普通 Error**：返回 message 原文，code = -1
 * 4. **unknown**：兜底 `CommonErrorCode.INTERNAL_ERROR`
 *
 * 替代 Phase 3 的 `I18nExceptionFilter`（被本 filter 合并）。
 */
@Catch()
export class ErrorsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorsFilter.name);

  constructor(private readonly i18n: I18nService) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<HttpRequestLike>();
    const res = ctx.getResponse<HttpResponseLike>();
    const lang = I18nContext.current()?.lang ?? "zh";

    const envelope = this.formatEnvelope(exception, lang, req);

    // 5xx 写 error 日志方便排查；4xx 业务错误不写（噪音）
    const httpStatus = this.httpStatusFor(exception);
    if (httpStatus >= 500) {
      this.logger.error(
        `${req.url ?? "?"} → ${envelope.code} ${envelope.message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    res.status(httpStatus).json(envelope);
  }

  private formatEnvelope(
    exception: unknown,
    lang: string,
    req: HttpRequestLike,
  ): ErrorEnvelope {
    const base = {
      success: false,
      timestamp: new Date().toISOString(),
      path: req.url ?? "",
      traceId: req.traceId,
    };

    if (exception instanceof AppError) {
      return {
        ...base,
        code: exception.errorCode.code,
        message: this.tryTranslate(
          exception.errorCode.message,
          lang,
          exception.i18nArgs,
        ),
        data: exception.data,
      };
    }

    if (exception instanceof HttpException) {
      const raw = exception.getResponse() as
        | string
        | { message?: unknown; errors?: unknown; [k: string]: unknown };

      // I18nZodValidationPipe 抛的形态：{ statusCode, message: "Validation failed", errors: [...] }
      if (
        typeof raw === "object" &&
        raw !== null &&
        Array.isArray((raw as { errors?: unknown }).errors)
      ) {
        return {
          ...base,
          code: CommonErrorCode.VALIDATION_FAILED.code,
          message: this.tryTranslate(
            CommonErrorCode.VALIDATION_FAILED.message,
            lang,
          ),
          data: { errors: (raw as { errors: unknown }).errors },
        };
      }

      const messageRaw =
        typeof raw === "string"
          ? raw
          : typeof raw?.message === "string"
            ? (raw.message as string)
            : exception.message;

      return {
        ...base,
        code: -1,
        message: this.tryTranslate(messageRaw, lang),
        data: null,
      };
    }

    if (exception instanceof Error) {
      return {
        ...base,
        code: CommonErrorCode.INTERNAL_ERROR.code,
        message: exception.message || CommonErrorCode.INTERNAL_ERROR.message,
        data: null,
      };
    }

    return {
      ...base,
      code: CommonErrorCode.INTERNAL_ERROR.code,
      message: this.tryTranslate(CommonErrorCode.INTERNAL_ERROR.message, lang),
      data: null,
    };
  }

  private httpStatusFor(exception: unknown): number {
    if (exception instanceof AppError) {
      return exception.errorCode.httpStatus ?? 200;
    }
    if (exception instanceof HttpException) {
      return exception.getStatus();
    }
    return CommonErrorCode.INTERNAL_ERROR.httpStatus ?? 500;
  }

  private tryTranslate(
    raw: string,
    lang: string,
    args: Record<string, unknown> = {},
  ): string {
    if (!raw || !raw.includes(".")) return raw;
    try {
      const translated = this.i18n.translate(raw, { lang, args }) as string;
      return translated ?? raw;
    } catch {
      return raw;
    }
  }
}
