import { defineErrorCode } from "./error-code";

/**
 * 框架级错误码 —— Phase 5 Track A1。
 *
 * 范围 0-999（约定见 `error-code.ts` 注释）：
 * - 0：success 哨兵（响应 envelope `code: 0` 表示成功）
 * - 1-9：通用错误（校验 / 认证 / 权限 / 找不到 / 冲突 / 限流）
 * - 999：兜底（unknown / 内部错误）
 *
 * 业务错误（如「邮箱已注册」「设备已绑定」）从 lib 业务范围申请，**不**走 CommonErrorCode。
 *
 * 这些 i18n key 必须在 server-* `i18n/{zh,en}/common.json` 中存在。
 */
export const CommonErrorCode = defineErrorCode({
  /** 成功哨兵；ResponseInterceptor 包装成功响应时使用 */
  SUCCESS: { code: 0, message: "common.success" },

  /** 请求体 / 查询参数 / 路径参数校验失败 */
  VALIDATION_FAILED: {
    code: 1,
    message: "common.validationFailed",
    httpStatus: 400,
  },

  /** 未携带 / 携带过期 token */
  UNAUTHORIZED: {
    code: 2,
    message: "common.unauthorized",
    httpStatus: 401,
  },

  /** 已认证但无权访问 */
  FORBIDDEN: {
    code: 3,
    message: "common.forbidden",
    httpStatus: 403,
  },

  /** 资源不存在 */
  NOT_FOUND: {
    code: 4,
    message: "common.notFound",
    httpStatus: 404,
  },

  /** 唯一约束 / 状态机冲突 */
  CONFLICT: {
    code: 5,
    message: "common.conflict",
    httpStatus: 409,
  },

  /** 限流命中（ProxyThrottlerGuard 抛出） */
  TOO_MANY_REQUESTS: {
    code: 6,
    message: "common.tooManyRequests",
    httpStatus: 429,
  },

  /** 兜底：未识别异常 / 内部错误 */
  INTERNAL_ERROR: {
    code: 999,
    message: "common.internalError",
    httpStatus: 500,
  },
});
