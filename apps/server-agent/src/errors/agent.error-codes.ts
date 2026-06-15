import { defineErrorCode } from "@meshbot/common";

/**
 * server-agent 业务错误码 —— Phase 5 起切到 AppError 体系。
 *
 * 范围：**3000-3999**（按 `check:error-code` 围栏分配）。
 *
 * i18n key 与 `apps/server-agent/i18n/{zh,en}/auth.json` 同步。
 */
export const AgentErrorCode = defineErrorCode({
  AUTH_ALREADY_REGISTERED: {
    code: 3001,
    message: "auth.alreadyRegistered",
  },
  AUTH_INVALID_CREDENTIALS: {
    code: 3002,
    message: "auth.invalidCredentials",
  },
  AUTH_UNAUTHORIZED: {
    code: 3003,
    message: "auth.unauthorized",
    httpStatus: 401,
  },
  CLOUD_UNREACHABLE: {
    code: 3004,
    message: "cloud.unreachable",
    httpStatus: 503,
  },
  IM_NOT_CONNECTED: {
    code: 3005,
    message: "im.notConnected",
    httpStatus: 503,
  },
  CROSS_ACCOUNT_WRITE: {
    code: 3006,
    message: "account.crossWrite",
    httpStatus: 403,
  },
});
