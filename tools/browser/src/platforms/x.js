export const loginUrl = "https://x.com/login";
export const homeUrl = "https://x.com/home";
/** 占位：Task 6 用真实选择器替换。 */
export async function isLoggedIn(page) {
  return !/\/login|\/i\/flow\/login/.test(page.url());
}
export async function post() {
  throw new Error("x.post 未实现（Task 6）");
}
export async function parseComments() {
  throw new Error("x.parseComments 未实现（Task 6）");
}
