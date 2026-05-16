/**
 * 业务错误码定义类型 —— Phase 5 Track A1。
 *
 * 设计要点：
 * - `code`：全局唯一数字编号。按 lib / app 划分范围（详见 `check:error-code` 围栏）：
 *     `libs/common`        → 0（success 哨兵） + 1-999（框架级错误）
 *     `libs/main`          → 2000-2999
 *     `libs/agent` / 等    → 3000-3999
 *     预留 4000+
 * - `message`：i18n key（如 `"auth.emailAlreadyExists"`）。`ErrorsFilter` 在抛出时
 *    通过 `I18nService.translate(message, { lang, args })` 翻译；翻译失败 fallback
 *    成原 key。
 * - `httpStatus`：默认 200。
 *     **业务错误**（如 email 已存在 / 密码不对）走 HTTP 200 + envelope `success:false`，
 *     不污染 HTTP 语义；前端按 `success` 字段统一判断。
 *     **框架级错误**（401 / 403 / 404 / 429 / 500）才用对应 4xx/5xx，便于网关 / CDN /
 *     边缘代理识别（限流 / 缓存 / 重试策略等基础设施依赖 HTTP 语义）。
 *
 * 用法见 `app.error.ts` 与 `common.error-codes.ts`。
 */
export interface ErrorCode {
  /** 全局唯一数字编号。 */
  readonly code: number;
  /** i18n key；翻译命中走翻译，否则原样作为 message。 */
  readonly message: string;
  /** HTTP 响应状态码。默认 200（业务错误用 envelope `success:false` 区分）。 */
  readonly httpStatus?: number;
}

/**
 * 仅做编译期类型 alias，运行期把 codes 原样返回。
 *
 * ```ts
 * export const MainErrorCode = defineErrorCode({
 *   AUTH_EMAIL_EXISTS:    { code: 2001, message: "auth.emailAlreadyExists" },
 *   AUTH_INVALID_CRED:    { code: 2002, message: "auth.invalidCredentials" },
 * });
 * ```
 *
 * 配合 `check:error-code` 围栏校验范围 + 唯一性 + 跳号。
 */
export function defineErrorCode<T extends Record<string, ErrorCode>>(
  codes: T,
): T {
  return codes;
}
