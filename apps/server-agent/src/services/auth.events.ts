/** 认证相关事件名常量：DeviceAuthorizeService 等发射，供其他模块订阅。 */
export const AUTH_EVENTS = {
  /** 浏览器授权登录完成（本地已建运行时、签发本地 JWT）。 */
  authorized: "auth.authorized",
  /** 云端凭据吊销/401：该账号需要重新授权登录（relay connect_error / REST 401 均可触发）。 */
  reauthRequired: "auth.reauth_required",
} as const;
