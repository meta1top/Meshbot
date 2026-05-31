export const loginUrl = "https://x.com/login";
export const homeUrl = "https://x.com/home";

// 登录态主导航元素（仅登录后存在）。实测：登出态这些 testid count 全为 0，
// 故"任一存在"= 已登录。URL 判断不可靠（登出态会落在 https://x.com/ 根，不含 /login）。
const LOGGED_IN_MARKERS = [
  '[data-testid="SideNav_AccountSwitcher_Button"]',
  '[data-testid="SideNav_NewTweet_Button"]',
  '[data-testid="AppTabBar_Home_Link"]',
];

/** 真实登录态判断：等任一登录态主导航元素出现（最长 ~4s），出现即已登录。 */
export async function isLoggedIn(page) {
  try {
    await page.waitForSelector(LOGGED_IN_MARKERS.join(", "), { timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}
export async function post() {
  throw new Error("x.post 未实现（Task 6）");
}
export async function parseComments() {
  throw new Error("x.parseComments 未实现（Task 6）");
}
