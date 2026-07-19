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
  SKILL_INSTALL_FAILED: {
    code: 3007,
    message: "skill.installFailed",
  },
  SKILL_NOT_FOUND: {
    code: 3008,
    message: "skill.notFound",
    httpStatus: 404,
  },
  SKILL_UNSAFE_ARCHIVE: {
    code: 3009,
    message: "skill.unsafeArchive",
  },
  SKILL_SOURCE_UNSUPPORTED: {
    code: 3010,
    message: "skill.sourceUnsupported",
  },
  DRIVE_UPLOAD_FAILED: {
    code: 3011,
    message: "drive.uploadFailed",
  },
  DRIVE_DOWNLOAD_FAILED: {
    code: 3012,
    message: "drive.downloadFailed",
  },
  DRIVE_SHARE_TARGET_INVALID: {
    code: 3013,
    message: "drive.shareTargetInvalid",
    httpStatus: 400,
  },
  DRIVE_SHARE_FETCH_FAILED: {
    code: 3014,
    message: "drive.shareFetchFailed",
  },
  AUTH_NO_PENDING_REQUEST: {
    code: 3015,
    message: "auth.noPendingRequest",
  },
  REMOTE_QUERY_TIMEOUT: {
    code: 3016,
    message: "im.remoteQueryTimeout",
    httpStatus: 504,
  },
  REMOTE_QUERY_UNAVAILABLE: {
    code: 3017,
    message: "im.remoteQueryUnavailable",
    httpStatus: 409,
  },
  MODEL_CONFIG_READONLY: {
    code: 3018,
    message: "modelConfig.readonly",
    httpStatus: 409,
  },
  /**
   * HITL 卡片已被其它端应答（Agent 级观察通道 D3 先到先得）。
   * `ConfirmationService` 是单例挂起核心，天然只 resolve 一次；晚到的应答
   * 收到本错误，客户端据此把卡片置为**已完成**而非弹错误框。
   */
  HITL_ALREADY_ANSWERED: {
    code: 3019,
    message: "im.hitlAlreadyAnswered",
    httpStatus: 409,
  },
});
