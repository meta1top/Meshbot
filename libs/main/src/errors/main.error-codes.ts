import { defineErrorCode } from "@meshbot/common";

/**
 * server-main 业务错误码 —— Phase 5 起切到 AppError 体系。
 *
 * 范围：**2000-2999**（按 `check:error-code` 围栏分配）。
 *
 * 抛出方式：
 * ```ts
 * import { AppError } from "@meshbot/common";
 * import { MainErrorCode } from "@meshbot/main";
 *
 * throw new AppError(MainErrorCode.AUTH_EMAIL_EXISTS);
 * ```
 *
 * 默认 `httpStatus` 200（业务错误用响应 envelope 的 `success:false` + 数字 `code`
 * 区分，不污染 HTTP 语义）；前端按 `success` / `code` 字段判断错误类型。
 *
 * i18n key 与 `apps/server-main/i18n/{zh,en}/auth.json` 同步。
 */
export const MainErrorCode = defineErrorCode({
  AUTH_EMAIL_EXISTS: {
    code: 2001,
    message: "auth.emailAlreadyExists",
  },
  AUTH_INVALID_CREDENTIALS: {
    code: 2002,
    message: "auth.invalidCredentials",
  },
  ORG_NOT_FOUND: {
    code: 2003,
    message: "org.notFound",
  },
  ORG_FORBIDDEN: {
    code: 2004,
    message: "org.forbidden",
    httpStatus: 403,
  },
  INVITATION_INVALID: {
    code: 2005,
    message: "org.invitationInvalid",
  },
  INVITATION_EXPIRED: {
    code: 2006,
    message: "org.invitationExpired",
  },
  CONVERSATION_NOT_FOUND: {
    code: 2007,
    message: "im.conversationNotFound",
  },
  CONVERSATION_FORBIDDEN: {
    code: 2008,
    message: "im.conversationForbidden",
    httpStatus: 403,
  },
  CHANNEL_NAME_INVALID: {
    code: 2009,
    message: "im.channelNameInvalid",
  },
  DM_TARGET_INVALID: {
    code: 2010,
    message: "im.dmTargetInvalid",
  },
});
