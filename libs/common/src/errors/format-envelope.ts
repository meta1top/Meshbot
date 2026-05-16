import { HttpException } from "@nestjs/common";
import type { I18nService } from "nestjs-i18n";

import { AppError } from "./app.error";
import { CommonErrorCode } from "./common.error-codes";

/**
 * 错误响应 envelope —— HTTP / WebSocket 共用形态（Phase 6 D1）。
 *
 * 成功响应由 `ResponseInterceptor` 包装；失败由 `ErrorsFilter` /
 * `WsExceptionFilter` 走本 helper。`path` 字段仅 HTTP 有意义，
 * WS 场景留空字符串。
 */
export interface ErrorEnvelope {
  success: false;
  code: number;
  message: string;
  data: unknown;
  timestamp: string;
  path: string;
  traceId?: string;
}

export interface FormatEnvelopeContext {
  /** 当前请求语言；缺省走 i18n service 兜底（zh） */
  lang: string;
  /** HTTP path（WS 场景传 ""） */
  path: string;
  /** 关联 traceId（HTTP 走 req.traceId，WS 走 client.data.traceId） */
  traceId?: string;
  /** 用于翻译 i18n key；失败 fallback 原 key */
  i18n: I18nService;
}

/**
 * 把任意 throw 转成统一 envelope。HTTP / WS 共用。
 *
 * 处理分支：
 * 1. **AppError**：取 `errorCode.code/message/data`，message 走 i18n
 * 2. **HttpException**：
 *    - response 形如 `{ errors: [...] }`（`I18nZodValidationPipe` 抛出）→ VALIDATION_FAILED
 *    - 否则 message 作 i18n key 翻译，code = -1（未分类）
 * 3. **Error**：returns Message 原文，code = INTERNAL_ERROR
 * 4. **unknown**：兜底 INTERNAL_ERROR
 */
export function formatEnvelope(
  exception: unknown,
  ctx: FormatEnvelopeContext,
): ErrorEnvelope {
  const base = {
    success: false as const,
    timestamp: new Date().toISOString(),
    path: ctx.path,
    traceId: ctx.traceId,
  };

  if (exception instanceof AppError) {
    return {
      ...base,
      code: exception.errorCode.code,
      message: tryTranslate(
        ctx.i18n,
        exception.errorCode.message,
        ctx.lang,
        exception.i18nArgs,
      ),
      data: exception.data,
    };
  }

  if (exception instanceof HttpException) {
    const raw = exception.getResponse() as
      | string
      | { message?: unknown; errors?: unknown; [k: string]: unknown };

    if (
      typeof raw === "object" &&
      raw !== null &&
      Array.isArray((raw as { errors?: unknown }).errors)
    ) {
      return {
        ...base,
        code: CommonErrorCode.VALIDATION_FAILED.code,
        message: tryTranslate(
          ctx.i18n,
          CommonErrorCode.VALIDATION_FAILED.message,
          ctx.lang,
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
      message: tryTranslate(ctx.i18n, messageRaw, ctx.lang),
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
    message: tryTranslate(
      ctx.i18n,
      CommonErrorCode.INTERNAL_ERROR.message,
      ctx.lang,
    ),
    data: null,
  };
}

/** AppError / HttpException 通用的 HTTP 状态码导出（filter 复用） */
export function httpStatusFor(exception: unknown): number {
  if (exception instanceof AppError) {
    return exception.errorCode.httpStatus ?? 200;
  }
  if (exception instanceof HttpException) {
    return exception.getStatus();
  }
  return CommonErrorCode.INTERNAL_ERROR.httpStatus ?? 500;
}

function tryTranslate(
  i18n: I18nService,
  raw: string,
  lang: string,
  args: Record<string, unknown> = {},
): string {
  if (!raw || !raw.includes(".")) return raw;
  try {
    const translated = i18n.translate(raw, { lang, args }) as string;
    return translated ?? raw;
  } catch {
    return raw;
  }
}
