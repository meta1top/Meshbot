/**
 * 云协同前端（web-main）token 本地存储。
 *
 * key 与 web-agent（`meshbot_access_token`）刻意隔离——两条轨的账号体系互不相干，
 * 同一浏览器同时打开 agent 桌面端 UI 与云协同前端时不能互相覆盖 token。
 */
const MAIN_TOKEN_KEY = "meshbot_main_token";

/** 读取当前云协同 token；SSR / 无 token 时返回 null。 */
export function getMainToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(MAIN_TOKEN_KEY);
}

/** 写入云协同 token（登录 / 验证邮箱 / 切换组织后调用）。 */
export function setMainToken(token: string): void {
  window.localStorage.setItem(MAIN_TOKEN_KEY, token);
}

/** 清除云协同 token（登出 / 401 时调用）。 */
export function clearMainToken(): void {
  window.localStorage.removeItem(MAIN_TOKEN_KEY);
}
