import type { ErrorCode } from "./error-code";

/**
 * 业务错误统一异常 —— Phase 5 Track A1。
 *
 * 抛出方式：
 * ```ts
 * throw new AppError(MainErrorCode.AUTH_EMAIL_EXISTS);
 * throw new AppError(MainErrorCode.AUTH_INVALID_CRED, { hint: "再试一次" });
 * throw new AppError(CommonErrorCode.VALIDATION_FAILED, { errors }, { field: "email" });
 * ```
 *
 * `ErrorsFilter` 捕获后：
 * - 走 `errorCode.httpStatus`（默认 200）
 * - `message` 当作 i18n key 翻译，args 取自 `i18nArgs`
 * - `data` 透传到响应 envelope 的 `data` 字段
 *
 * 不应继承 `HttpException` —— 与 NestJS 的内置异常分层解耦，filter 一并 `@Catch()` 兜底。
 */
export class AppError extends Error {
  constructor(
    public readonly errorCode: ErrorCode,
    public readonly data: unknown = null,
    public readonly i18nArgs: Record<string, unknown> = {},
  ) {
    super(errorCode.message);
    this.name = "AppError";
    // 保持 instanceof AppError 在 NestJS 经过事务装饰器 / Promise rejection 等场景里依旧成立
    Object.setPrototypeOf(this, AppError.prototype);
  }
}
