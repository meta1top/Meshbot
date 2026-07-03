/** 认证相关事件名常量：DeviceAuthorizeService 等发射，供其他模块订阅。 */
export const AUTH_EVENTS = {
  /** 浏览器授权登录完成（本地已建运行时、签发本地 JWT）。 */
  authorized: "auth.authorized",
} as const;
